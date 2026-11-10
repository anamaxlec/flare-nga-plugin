const HOST = "bbs.nga.cn";
const ORIGIN = "https://" + HOST;
const LOGIN = "/nuke.php?__lib=login&__act=account&login";
const SESSION = "/nuke.php?__lib=noti&__act=if";
const CAPS = {
  "flare.datasource.timeline/v1": ["page"],
  "flare.datasource.tab-catalog/v1": ["page"],
  "flare.datasource.post/v1": ["detail", "context"],
  "flare.datasource.profile/v1": ["byId", "byHandle"],
};
const LANGUAGE = ["zh-CN"];
const FORUM_INDEX = "/nuke.php?__lib=nga_index&__act=get_all_forums";
const SUBBOARD_BATCH_SIZE = 4;
const HTTP_TIMEOUT_MILLIS = 12_000;
const MAX_QUOTE_CARDS = 100;
// NGA uses the same floor metadata for quoted posts and standalone "Reply to" headers.
const REPLY_HEADER = /^\s*(?:\[b\]\s*Reply to\s+)?\[pid=(\d{1,16}),(\d{1,16}),\d+\][^\[]*\[\/pid\]\s*(?:\[b\])?Post by\s+\[uid=(\d{1,16})\]([^\[]+)\[\/uid\]\s*\(([^)]+)\):?\s*\[\/b\]/i;
const BOARDS = [
  { name: "游戏讨论", forums: [
    ["7", "艾泽拉斯议事厅"], ["310", "精英议会"], ["510569", "魔兽世界：无限"],
    ["-152678", "英雄联盟"], ["321", "DOTA2"], ["459", "守望先锋"],
    ["489", "怪物猎人"], ["428", "手游讨论"], ["650", "原神"],
    ["-34587507", "明日方舟"], ["538", "阴阳师"],
  ] },
  { name: "综合交流", forums: [
    ["-7", "网事杂谈"], ["-447601", "二次元国家地理"],
    ["334", "硬件配置"], ["436", "消费电子 IT新闻"], ["-576177", "音乐影视"],
  ] },
  { name: "社区事务 · 合集", forums: [["510343", "赛车俱乐部"]] },
] as const;
const SUBBOARD_PARENTS = [...new Set(["7", "321", "650", "510343",
  ...BOARDS.flatMap(({ forums }) => forums.map(([fid]) => fid)),
])];

type Row = Record<string, unknown>;
type Cookie = { name: string; value: string };

defineFlareSocialPlugin({
  detector: {
    detect({ origin }) {
      if (![ORIGIN, "https://ngabbs.com", "https://nga.178.com"].includes(origin)) {
        return { match: "none", canonicalOrigin: origin };
      }
      return { match: "exact", canonicalOrigin: ORIGIN, software: "NGA", instance: { domain: HOST, title: "NGA 玩家社区" } };
    },
  },
  login: {
    browser: {
      begin() { return { type: "webCookie", startUrl: ORIGIN + LOGIN }; },
      async check(request) {
        const cookies = request.cookies.cookies.filter(({ sourceUrl }) => sourceUrl === ORIGIN + SESSION + "&__output=11")
          .map(({ name, value }) => ({ name, value }));
        const accountId = numeric(cookies.find(({ name }) => name === "ngaPassportUid")?.value);
        if (!accountId || !cookies.some(({ name, value }) => name === "ngaPassportCid" && value)) return { type: "pending" };
        const response = await get(SESSION, cookies);
        if (response.status !== 200 || response.root?.error || response.root?.data == null) return { type: "pending" };
        const found = await accountProfile(accountId, cookies).catch(() => undefined);
        const profile = user(accountId, found?.username ?? "", found) ?? { key: key(accountId), handle: accountId, displayName: "NGA 用户 " + accountId };
        return { type: "success", value: { accountId, origin: ORIGIN, profile, credential: { cookies }, capabilities: CAPS } };
      },
    },
  },
  capabilities: {
    timeline: {
      async page(request, context) {
        const fid = forumId(request.parameters?.fid ?? request.page.parameters?.fid);
        if (fid === undefined) fail("Validation", "没有指定 NGA 版面");
        const position = cursor(request.page);
        const data = await api("/thread.php?fid=" + fid + "&page=" + position.batch, context);
        const forum = obj(data.__F);
        const name = str(forum?.name) || boardName(fid);
        const topics = rows(data.__T);
        const items: TimelineItemV1[] = topics.flatMap((thread) => {
          const tid = numeric(thread.tid);
          if (!tid || (position.batch > 1 && (Number(thread.type) & 5120) !== 0)) return [];
          return [{ type: "feed", feed: topicFeed(thread, tid, fid, name, forum) }];
        });
        const total = number(data.__ROWS);
        const batchSize = number(data.__T__ROWS_PAGE) ?? 35;
        return slice(items, request.page, position, topics.length > 0 && total !== undefined && position.batch * batchSize < total);
      },
    },
    tabCatalog: {
      async page(request, context) {
        const offset = request.direction === "refresh" ? 0 : number(/^subboards:(\d+)$/.exec(request.cursor ?? "")?.[1]);
        if (offset === undefined || request.direction === "newer") return { items: [], endReached: true };
        const sections: TimelineSectionV1[] = offset === 0 ? BOARDS.map(({ name, forums }, index) => ({
          id: "group-" + index, title: { value: name },
          timelines: { items: forums.map(([fid, name]) => board(fid, name)), endReached: true },
        })) : [];
        const parents = SUBBOARD_PARENTS.slice(offset, offset + SUBBOARD_BATCH_SIZE);
        const cookies = await cookiesFor(context);
        const index = offset === 0 ? get(FORUM_INDEX, [], 11, 4_000).catch(() => undefined) : undefined;
        const children = await Promise.all(parents.map(async (fid) => {
          const data = await api("/thread.php?fid=" + fid + "&page=1", context, cookies).catch(() => undefined);
          const forum = obj(data?.__F);
          const name = str(forum?.name) || boardName(fid);
          if (!name) return undefined;
          const items = Object.entries(obj(forum?.sub_forums) ?? {}).flatMap(([entry, value]) => {
            const row = list(value);
            const childId = forumId(entry);
            const childName = decodeLabel(row[1]);
            // t-prefixed entries link to single threads, not child forums.
            return childId && childId !== fid && childName ? [board(childId, name + " · " + childName, fid)] : [];
          });
          return items.length ? {
            id: "sub-" + fid, title: { value: name },
            timelines: { items, endReached: true },
          } : undefined;
        }));
        for (const section of children) if (section) sections.push(section);
        if (index) {
          const response = await index;
          if (response?.status === 200) sections.push(...publicBoardSections(response.root?.data, sections));
        }
        const next = offset + parents.length;
        const endReached = next >= SUBBOARD_PARENTS.length;
        return { items: sections, olderCursor: endReached ? undefined : "subboards:" + next, endReached };
      },
    },
    profile: {
      async byId({ key: { id } }, context) {
        const uid = numeric(id);
        if (!uid) fail("NotFound", "找不到这个 NGA 用户");
        const profile = await accountProfile(uid, await cookiesFor(context));
        return publicProfile(profile);
      },
      async byHandle({ handle }, context) {
        const cookies = await cookiesFor(context);
        const uid = numeric(handle);
        if (uid) return publicProfile(await accountProfile(uid, cookies));
        const { root } = await get("/nuke.php?__lib=ucp&__act=get&username=" + encodeURIComponent(handle), cookies, 14);
        return publicProfile(rows(root?.result)[0]);
      },
    },
    post: {
      async detail({ key: { id } }, context) { return loadPost(id, context); },
      async context({ key: { id }, page }, context) {
        const ref = postRef(id);
        if (ref.pid) {
          const items: TimelineItemV1[] = page.direction === "refresh" ? [{ type: "post", ...await loadPost(id, context) }] : [];
          return { items, endReached: true };
        }
        const position = cursor(page);
        const data = await loadThread(ref.tid, position.batch, context, position.batch === 1 && position.skip === 0);
        const items: TimelineItemV1[] = data.replies.flatMap((row) => {
          const pid = numeric(row.pid);
          const root = number(row.lou) === 0;
          if (root ? position.batch !== 1 : !pid) return [];
          const keyId = root ? ref.tid : "p" + ref.tid + "-" + pid + "-" + position.batch;
          return [{ type: "post", ...floor(row, data, keyId) }];
        });
        return slice(items, page, position, data.hasMore);
      },
    },
  },
});

function board(fid: string, name: string, parent?: string): TimelineDescriptorV1 {
  const id = parent ? "forum-" + parent + "-sub-" + fid : "forum-" + fid;
  return { id, title: { value: name }, icon: "Channel", parameters: { fid } };
}

function publicBoardSections(data: unknown, featured: TimelineSectionV1[]): TimelineSectionV1[] {
  const groups = obj(rows(data)[0]?.all);
  const seen = new Set(featured.flatMap((section) => (section.timelines.items ?? [])
    .flatMap((timeline) => timeline.parameters?.fid ?? [])));
  const sections: TimelineSectionV1[] = [];
  for (const group of rows(groups)) {
    const name = decodeLabel(group.name);
    if (!name) continue;
    const items = collectPublicBoards(group, seen);
    // Flare v1 limits each section's timeline page to 200 rows.
    for (let start = 0; start < items.length; start += 200) {
      sections.push({ id: "index-" + sections.length, title: { value: name },
        timelines: { items: items.slice(start, start + 200), endReached: true } });
    }
  }
  return sections;
}

function collectPublicBoards(group: Row, seen: Set<string>): TimelineDescriptorV1[] {
  return rows(group.content).flatMap((entry) => {
    const fid = forumId(entry.fid);
    const name = decodeLabel(entry.name);
    if (!fid) return collectPublicBoards(entry, seen);
    if (!name || numeric(entry.stid) || seen.has(fid)) return [];
    seen.add(fid);
    return [board(fid, name)];
  });
}

async function get(path: string, cookies: Cookie[], output = 11, timeoutMillis = HTTP_TIMEOUT_MILLIS) {
  const response = await flare.http.request({
    url: ORIGIN + path + "&__output=" + output,
    cookies,
    timeoutMillis,
    headers: {
      Accept: "application/json",
      Referer: ORIGIN + "/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    },
  }).catch(() => fail("Network", "连接 NGA 失败，请重试"));
  let root: Row | undefined;
  try { root = obj(JSON.parse(response.body)); } catch { /* Check the status below. */ }
  return { status: response.status, root };
}

async function api(path: string, context: PluginInvocationContextV1, cookies?: Cookie[]): Promise<Row> {
  let result = await get(path, cookies ?? await cookiesFor(context));
  if (context.scope === "guest" && str(list(result.root?.error)[0]).startsWith("15:")) {
    // Use the same anonymous session token NGA's browser page offers when entering as a guest.
    const script = str(list(result.root?.error)[1]);
    const guest = /document\.cookie\s*=\s*'guestJs=(\d{1,14}_[a-z0-9]{1,64});/i.exec(script)?.[1];
    if (guest) result = await get(path + "&rand=" + Date.now(), [{ name: "guestJs", value: guest }]);
  }
  const { status, root } = result;
  const data = obj(root?.data);
  const details = data?.__MESSAGE;
  const message = str(list(root?.error)[0]) || str(root?.msg) ||
    str(list(details)[1] ?? obj(details)?.["1"]);
  if (status === 401 || status === 403 || /未登录|先登录|访客|权限/.test(message)) {
    fail("AuthenticationRequired", message || "请登录 NGA 或检查版面权限");
  }
  if (status === 404 || /帖子不存在|主题不存在|找不到/.test(message)) fail("NotFound", message || "NGA 页面不存在");
  if (status === 429) fail("RateLimited", "NGA 请求过于频繁");
  if (status >= 400 || message) fail("Remote", message || "NGA 暂时无法返回数据");
  if (!data) fail("InvalidResponse", "NGA 没有返回可读取的数据");
  return data;
}

async function cookiesFor(context: PluginInvocationContextV1): Promise<Cookie[]> {
  if (context.scope !== "account" || !context.credentialAvailable) return [];
  return list(obj(await flare.credential.read())?.cookies).flatMap((entry) => {
    const value = obj(entry);
    const name = str(value?.name);
    const cookie = str(value?.value);
    return name && cookie ? [{ name, value: cookie }] : [];
  });
}

async function accountProfile(uid: string, cookies: Cookie[], timeoutMillis?: number): Promise<Row | undefined> {
  const { root } = await get("/nuke.php?__lib=ucp&__act=get&uid=" + uid, cookies, 14, timeoutMillis);
  return rows(root?.result).find((profile) => numeric(profile.uid) === uid);
}

function publicProfile(row: Row | undefined): ProfileV1 {
  const profile = user(numeric(row?.uid), row?.username, row);
  if (!profile) fail("NotFound", "找不到这个 NGA 用户");
  return profile;
}

async function loadThread(tid: string, batch: number, context: PluginInvocationContextV1, withAuthorAvatar: boolean) {
  const cookies = await cookiesFor(context);
  const data = await api("/read.php?tid=" + tid + "&page=" + batch, context, cookies);
  const thread = obj(data.__T);
  const replies = rows(data.__R);
  if (!thread || !replies.length) fail("NotFound", "找不到这篇帖子或楼层");
  const size = number(data.__R__ROWS_PAGE) ?? 20;
  const total = number(data.__ROWS);
  const users = obj(data.__U) ?? {};
  const authorId = numeric(replies.find((row) => number(row.lou) === 0)?.authorid) ?? numeric(thread.authorid);
  if (withAuthorAvatar && cookies.length && authorId && !avatarUrl(str(obj(users[authorId])?.avatar))) {
    const profile = await accountProfile(authorId, cookies, 2_000).catch(() => undefined);
    if (profile?.avatar) users[authorId] = { ...obj(users[authorId]), avatar: profile.avatar };
  }
  return {
    tid, batch, thread, replies, users, forum: obj(data.__F),
    attachmentHost: str(obj(data.__GLOBAL)?._ATTACH_BASE_VIEW),
    hasMore: total !== undefined ? batch * size < total : replies.length >= size,
  };
}

async function loadPost(id: string, context: PluginInvocationContextV1): Promise<TimelinePostV1> {
  const { tid, pid, batch } = postRef(id);
  const thread = await loadThread(tid, batch, context, !pid);
  const row = thread.replies.find((row) => pid ? numeric(row.pid) === pid : number(row.lou) === 0);
  if (!row) fail("NotFound", "找不到这个楼层");
  return floor(row, thread, id);
}

function postRef(id: string) {
  if (numeric(id)) return { tid: id, batch: 1, pid: undefined };
  const reply = /^p(\d+)-(\d+)-(\d+)$/.exec(id);
  if (!reply) fail("NotFound", "无法识别这个帖子");
  return { tid: reply[1], pid: reply[2], batch: Number(reply[3]) };
}

function boardName(fid: string): string {
  return BOARDS.flatMap(({ forums }) => [...forums]).find(([id]) => id === fid)?.[1] ?? "";
}

function topicFeed(thread: Row, tid: string, currentFid: string, currentName: string, forum?: Row): FeedV1 {
  const parentName = decodeLabel(obj(thread.parent)?.["2"] ?? list(thread.parent)[2]);
  const mirror = parentName === "版面镜像"
    ? forumId(obj(thread.topic_misc_var)?.["3"] ?? list(thread.topic_misc_var)[3])
    : undefined;
  const title = decodeLabel(thread.subject) || "NGA 主题";
  const createdAt = time(number(thread.lastpost) || thread.postdate);
  const threadId = numeric(thread.quote_from) ?? tid;
  const external = mirror ? ORIGIN + "/thread.php?fid=" + mirror : https(str(thread.jumpurl));
  const url = external ?? ORIGIN + "/read.php?tid=" + threadId;
  const sourceFid = forumId(thread.fid) ?? currentFid;
  const childName = decodeLabel(list(obj(forum?.sub_forums)?.[sourceFid])[1]);
  const source = parentName || childName || (sourceFid === currentFid ? decodeLabel(currentName) : boardName(sourceFid));
  const author = decodeLabel(thread.author);
  const replies = number(thread.replies);
  const metadata = mirror ? "" : [author, replies === undefined ? "" : replies + " 条回复"].filter(Boolean).join(" · ");
  return {
    title, url, createdAt,
    source: { name: source || "NGA" },
    description: metadata ? { format: "plain", value: metadata } : undefined,
    target: external ? { type: "link", url } : { type: "post", key: key(threadId) },
    sourceLanguages: LANGUAGE,
  };
}

function decodeLabel(value: unknown): string {
  return str(value).replace(/&(amp|quot|lt|gt|nbsp|#39);/g, (_, entity: string) =>
    ({ amp: "&", quot: '"', lt: "<", gt: ">", nbsp: " ", "#39": "'" })[entity] ?? "").trim();
}

function floor(row: Row, data: Awaited<ReturnType<typeof loadThread>>, id: string): TimelinePostV1 {
  const root = data.tid === id;
  const uid = numeric(row.authorid) ?? (root ? numeric(data.thread.authorid) : undefined);
  const author = obj(uid ? data.users[uid] : undefined);
  const name = row.author || (root ? data.thread.author : "") || author?.username;
  const media: MediaV1[] = [];
  const title = root ? str(data.thread.subject || row.subject) : "";
  const raw = str(row.content).replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const { text, quotes } = separateQuotes(raw, data);
  const body = trimBreaks(text
    .replace(/\[img(?:=[^\]]*)?\]([^\[]+)\[\/img\]/gi, (_, source: string) => {
      const url = mediaUrl(source, data.attachmentHost);
      if (url && media.length < 12 && !media.some((image) => image.url === url)) {
        media.push({ id: id + "-m" + media.length, type: /\.gif(?:$|[?#])/i.test(url) ? "gif" : "image", url });
      }
      return "";
    })
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_, source: string, title: string) => {
      const url = https(source);
      return url ? '<a href="' + escape(url) + '">' + title + "</a>" : title;
    })
    .replace(/\[pid=(\d+),(\d+),\d+\]([^\[]*)\[\/pid\]/gi, (_, pid: string, tid: string, label: string) =>
      '<a href="' + escape(floorUrl(tid, pid)) + '">' + (label === "Reply" ? "查看原回复" : label) + "</a>")
    .replace(/\[uid=\d+\]|\[\/uid\]/gi, "")
    .replace(/\[s:[\w-]+:([^\[\]<>&]+)\]/gi, "（$1）")
    .replace(/\[(\/?)(quote|b|i|u|s|del)(?:=[^\]]*)?\]/gi, (_, close: string, tag: string) =>
      "<" + close + (tag.toLowerCase() === "quote" ? "blockquote" : tag.toLowerCase()) + ">")
    .replace(/\[\/?(?:size|font|color|align|collapse)(?:=[^\]]*)?\]/gi, "")
    .replace(/(?:<br\s*\/?\s*>\s*){3,}/gi, "<br><br>"));
  return {
    post: {
      key: key(id), author: user(uid, name, author), createdAt: time(row.postdatetimestamp),
      content: { format: "html", value: (title ? "<b>" + escape(title) + "</b><br><br>" : "") + (body || " ") },
      media,
      repliesCount: root ? number(data.thread.replies) : undefined,
      url: floorUrl(data.tid, root ? "0" : str(row.pid)),
      sourceChannel: root && str(data.forum?.name) ? { id: str(data.thread.fid), name: str(data.forum?.name) } : undefined,
      sourceLanguages: LANGUAGE,
    },
    presentation: quotes.length ? { quotes } : undefined,
  };
}

function separateQuotes(content: string, data: Awaited<ReturnType<typeof loadThread>>) {
  const quotes: PostV1[] = [];
  const unlinked: string[] = [];
  const direct = REPLY_HEADER.exec(content);
  const bodyStart = direct?.[0].length ?? 0;
  if (direct) quotes.push(quotedFloor(direct, "", data));
  let offset = bodyStart;
  let text = "";
  let depth = 0;
  let start = 0;
  let inner = 0;
  const tags = /\[(\/?)quote(?:=[^\]]*)?\]/gi;
  tags.lastIndex = bodyStart;
  for (let tag = tags.exec(content); tag; tag = tags.exec(content)) {
    const index = tag.index;
    const end = index + tag[0].length;
    if (!tag[1]) {
      if (depth++ === 0) { start = index; inner = end; }
    } else if (depth > 0 && --depth === 0) {
      text += content.slice(offset, start);
      const excerpt = content.slice(inner, index);
      const header = REPLY_HEADER.exec(excerpt);
      if (header && quotes.length < MAX_QUOTE_CARDS) quotes.push(quotedFloor(header, excerpt.slice(header[0].length), data));
      else unlinked.push(content.slice(start, end));
      offset = end;
    }
  }
  return { text: [trimBreaks(text + content.slice(offset)), ...unlinked].filter(Boolean).join("<br><br>"), quotes };
}

function quotedFloor(header: RegExpExecArray, excerpt: string, data: Awaited<ReturnType<typeof loadThread>>): PostV1 {
  const [, pid, tid, uid, name, date] = header;
  const source = data.tid === tid ? data.replies.find((row) => str(row.pid) === pid) : undefined;
  const body = excerpt || str(source?.content).replace(REPLY_HEADER, "");
  const plain = decodeLabel(body
    .replace(/\[img(?:=[^\]]*)?\][\s\S]*?\[\/img\]/gi, " [图片] ")
    .replace(/\[pid=[^\]]+\][\s\S]*?\[\/pid\]/gi, "")
    .replace(/\[s:[\w-]+:([^\[\]<>&]+)\]/gi, "（$1）")
    .replace(/<br\b[^>]*>|<\/p>/gi, " ")
    .replace(/<[^>]*>|\[\/?[a-z][a-z\d_]*(?:=[^\]]*)?\]/gi, ""))
    .replace(/\s+/g, " ");
  const characters = Array.from(plain);
  const preview = characters.length > 96 ? characters.slice(0, 96).join("").trimEnd() + "…" : plain;
  const timestamp = number(source?.postdatetimestamp) ?? Date.parse(date.replace(" ", "T") + "+08:00") / 1000;
  return {
    // Flare caches quote cards by key. Keep the preview separate from the full floor.
    key: key("quote-" + tid + "-" + pid),
    author: user(numeric(uid), decodeLabel(name).slice(0, 1_024), obj(data.users[uid])), createdAt: time(timestamp),
    content: { format: "plain", value: preview || "查看原楼层" },
    url: floorUrl(tid, pid), detailType: "link", sourceLanguages: LANGUAGE,
  };
}

function trimBreaks(text: string): string {
  return text.trim().replace(/^(?:<br\s*\/?\s*>\s*)+|(?:\s*<br\s*\/?\s*>)+$/gi, "").trim();
}

function floorUrl(tid: string, pid: string): string {
  return ORIGIN + "/read.php?tid=" + tid + (pid === "0" ? "" : "&pid=" + pid);
}

function user(uid: string | undefined, value: unknown, profile?: Row): ProfileV1 | undefined {
  if (!uid) return undefined;
  const name = str(value).trim() || "UID " + uid;
  return {
    key: key(uid), handle: uid, displayName: name,
    avatarUrl: avatarUrl(str(profile?.avatar)),
    followersCount: number(profile?.follow_by_num),
    url: ORIGIN + "/nuke.php?__lib=ucp&__act=get&uid=" + uid,
  };
}

function avatarUrl(value: string): string | undefined {
  let candidates: unknown[];
  if (value.startsWith("/*$js$*/")) {
    try { candidates = Object.values(obj(JSON.parse(value.slice(8))) ?? {}); }
    catch { return undefined; }
  } else {
    candidates = value.replace(/%7c/gi, "|").split("|");
  }
  for (const candidate of candidates) {
    const entry = (Array.isArray(candidate) ? str(candidate[0]) : str(candidate)).trim();
    const remote = https(entry);
    if (remote) return remote;
    const short = /^\.a\/(\d+)_(\d+\.(?:jpe?g|png|gif|webp(?:\.jpg)?)(?:\?\d+)?)$/i.exec(entry);
    if (short) {
      const shard = Number(short[1]).toString(16).padStart(9, "0").slice(-9);
      return "https://img.nga.cn/avatars/2002/" + shard.slice(6) + "/" +
        shard.slice(3, 6) + "/" + shard.slice(0, 3) + "/" + short[1] + "_" + short[2];
    }
    if (/^[a-z\d_%-]+\.(?:jpe?g|png|gif|webp)$/i.test(entry)) {
      return "https://img4.nga.cn/ngabbs/face/" + entry;
    }
  }
  return undefined;
}

function cursor(page: PageRequestV1) {
  if (page.direction === "refresh") return { batch: 1, skip: 0 };
  const match = /^(\d+):(\d+)$/.exec(page.cursor ?? "");
  if (page.direction !== "older" || !match || !numeric(match[1]) || !Number.isSafeInteger(Number(match[2]))) fail("Validation", "分页位置无效");
  return { batch: Number(match[1]), skip: Number(match[2]) };
}
function slice<T>(rows: T[], page: PageRequestV1, position: { batch: number; skip: number }, hasMore: boolean): PageV1<T> {
  const end = position.skip + page.limit;
  const olderCursor = end < rows.length ? position.batch + ":" + end : hasMore ? (position.batch + 1) + ":0" : undefined;
  return { items: rows.slice(position.skip, end), olderCursor, endReached: !olderCursor };
}
function mediaUrl(value: string, attachmentHost: string) {
  const path = value.trim();
  if (path.startsWith("./") && /^[a-z\d.-]+\.nga\.cn\/attachments$/i.test(attachmentHost)) {
    return https("https://" + attachmentHost + "/" + path.slice(2));
  }
  return https(path);
}
function https(value: string): string | undefined {
  const url = value.trim().replace(/&amp;/g, "&").replace(/^http:/i, "https:").replace(/^\/\//, "https://");
  return /^https:\/\/[a-z\d.-]+(?::\d+)?(?:[/?#]|$)/i.test(url) && !/[\s<>"']/u.test(url) ? url : undefined;
}
function rows(value: unknown): Row[] {
  return (Array.isArray(value) ? value : Object.values(obj(value) ?? {})).map(obj).filter((row): row is Row => row !== undefined);
}
function obj(value: unknown): Row | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function str(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function numeric(value: unknown): string | undefined { const id = str(value); return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : undefined; }
function number(value: unknown): number | undefined { const id = str(value); return /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : undefined; }
function forumId(value: unknown): string | undefined { const id = str(value); return /^-?\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? id : undefined; }
function time(value: unknown): string {
  const n = number(value);
  return n && n < 10000000000 ? new Date(n * 1000).toISOString() : "1970-01-01T00:00:00.000Z";
}
function key(id: string): EntityKeyV1 { return { id, host: HOST }; }
function escape(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function fail(code: PluginErrorCodeV1, message: string): never { throw flare.error({ code, message: { value: message } }); }
