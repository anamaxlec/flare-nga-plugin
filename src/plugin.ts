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
const AVATAR_PLACEHOLDER = "https://img4.nga.cn/ngabbs/face/a_sheep.png";
const SUBBOARD_BATCH_SIZE = 4;
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
] as const;
const SUBBOARD_PARENTS = [...new Set(["7", "321", "650", "-447601",
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
        const cookies = await cookiesFor(context);
        const data = await api("/thread.php?fid=" + fid + "&page=" + position.batch, context, cookies);
        const users = obj(data.__U);
        const forum = obj(data.__F);
        const name = str(forum?.name) || BOARDS.flatMap(({ forums }) => [...forums]).find(([id]) => id === fid)?.[1];
        const topics = rows(data.__T);
        const items: TimelineItemV1[] = topics.flatMap((thread) => {
          const tid = numeric(thread.tid);
          if (!tid || (position.batch > 1 && (Number(thread.type) & 5120) !== 0)) return [];
          return [{ type: "post", post: preview(thread, tid, str(name), obj(users?.[str(thread.authorid)])) }];
        });
        const total = number(data.__ROWS);
        const batchSize = number(data.__T__ROWS_PAGE) ?? 35;
        const result = slice(items, request.page, position, topics.length > 0 && total !== undefined && position.batch * batchSize < total);
        if (cookies.length) await loadListAvatars(result.items ?? [], cookies);
        return result;
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
        const children = await Promise.all(parents.map(async (fid) => {
          const data = await api("/thread.php?fid=" + fid + "&page=1", context, cookies).catch(() => undefined);
          const forum = obj(data?.__F);
          const name = str(forum?.name) || BOARDS.flatMap(({ forums }) => [...forums]).find(([id]) => id === fid)?.[1];
          if (!name) return undefined;
          const items = Object.entries(obj(forum?.sub_forums) ?? {}).flatMap(([entry, value]) => {
            const row = list(value);
            const childId = forumId(entry);
            const childName = str(row[1]).trim();
            // t-prefixed entries link to single threads, not child forums.
            return childId && childId !== fid && childName ? [board(childId, name + " · " + childName, fid)] : [];
          });
          return items.length ? {
            id: "sub-" + fid, title: { value: name },
            timelines: { items, endReached: true },
          } : undefined;
        }));
        for (const section of children) if (section) sections.push(section);
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
      async detail({ key: { id } }, context) { return { post: await loadPost(id, context) }; },
      async context({ key: { id }, page }, context) {
        const ref = postRef(id);
        if (ref.pid) {
          const items: TimelineItemV1[] = page.direction === "refresh" ? [{ type: "post", post: await loadPost(id, context) }] : [];
          return { items, endReached: true };
        }
        const position = cursor(page);
        const data = await loadThread(ref.tid, position.batch, context);
        const items: TimelineItemV1[] = data.replies.flatMap((row) => {
          const pid = numeric(row.pid);
          if (!pid && number(row.lou) !== 0) return [];
          const keyId = pid ? "p" + ref.tid + "-" + pid + "-" + position.batch : ref.tid;
          if (keyId === ref.tid && position.batch !== 1) return [];
          return [{ type: "post", post: floor(row, data, keyId) }];
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

async function get(path: string, cookies: Cookie[], output = 11, timeoutMillis?: number) {
  const response = await flare.http.request({
    url: ORIGIN + path + "&__output=" + output,
    cookies,
    timeoutMillis,
    headers: {
      Accept: "application/json",
      Referer: ORIGIN + "/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    },
  });
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

async function loadListAvatars(items: TimelineItemV1[], cookies: Cookie[]) {
  const authors = new Map<string, ProfileV1[]>();
  for (const item of items) {
    if (item.type !== "post" || item.post.author?.avatarUrl !== AVATAR_PLACEHOLDER) continue;
    const author = item.post.author;
    const id = author.key.id;
    const group = authors.get(id) ?? [];
    group.push(author);
    authors.set(id, group);
  }
  // The UCP endpoint accepts one UID per call. Bound the additional work to the visible page.
  const pending = [...authors].slice(0, 20);
  for (let offset = 0; offset < pending.length; offset += 5) {
    await Promise.all(pending.slice(offset, offset + 5).map(async ([uid, profiles]) => {
      const user = await accountProfile(uid, cookies, 2_000).catch(() => undefined);
      const url = avatarUrl(str(user?.avatar));
      if (url) for (const profile of profiles) profile.avatarUrl = url;
    }));
  }
}

function publicProfile(row: Row | undefined): ProfileV1 {
  const profile = user(numeric(row?.uid), row?.username, row);
  if (!profile) fail("NotFound", "找不到这个 NGA 用户");
  return profile;
}

async function loadThread(tid: string, batch: number, context: PluginInvocationContextV1) {
  const data = await api("/read.php?tid=" + tid + "&page=" + batch, context);
  const thread = obj(data.__T);
  const replies = rows(data.__R);
  if (!thread || !replies.length) fail("NotFound", "找不到这篇帖子或楼层");
  const size = number(data.__R__ROWS_PAGE) ?? 20;
  const total = number(data.__ROWS);
  return {
    tid, batch, thread, replies, users: obj(data.__U) ?? {}, forum: obj(data.__F),
    attachmentHost: str(obj(data.__GLOBAL)?._ATTACH_BASE_VIEW),
    hasMore: total !== undefined ? batch * size < total : replies.length >= size,
  };
}

async function loadPost(id: string, context: PluginInvocationContextV1): Promise<PostV1> {
  const { tid, pid, batch } = postRef(id);
  const thread = await loadThread(tid, batch, context);
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

function preview(thread: Row, tid: string, forum: string, profile?: Row): PostV1 {
  const title = str(thread.subject);
  return {
    key: key(tid), author: user(numeric(thread.authorid), thread.author, profile),
    createdAt: time(thread.postdate),
    content: { format: "html", value: "<b>" + escape(title) + "</b>" },
    repliesCount: number(thread.replies),
    url: ORIGIN + "/read.php?tid=" + tid,
    sourceChannel: forum ? { id: str(thread.fid), name: forum } : undefined,
    sourceLanguages: LANGUAGE,
  };
}

function floor(row: Row, data: Awaited<ReturnType<typeof loadThread>>, id: string): PostV1 {
  const root = data.tid === id;
  const uid = numeric(row.authorid);
  const author = obj(uid ? data.users[uid] : undefined);
  const name = row.author || (root ? data.thread.author : "") || author?.username;
  const media: MediaV1[] = [];
  const title = root ? str(data.thread.subject || row.subject) : "";
  const body = str(row.content).replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
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
    .replace(/\[\/?(?:quote|b|i|u|s)(?:=[^\]]*)?\]/gi, (tag) => tag.toLowerCase().replace("quote", "blockquote").replace(/\[|\]/g, (ch) => ch === "[" ? "<" : ">").replace(/=[^>]+/, ""))
    .replace(/\[\/?(?:size|font|color|align|collapse)(?:=[^\]]*)?\]/gi, "")
    .replace(/(?:<br\s*\/?\s*>\s*){3,}/gi, "<br><br>")
    .trim();
  return {
    key: key(id), author: user(uid, name, author), createdAt: time(row.postdatetimestamp),
    content: { format: "html", value: (title ? "<b>" + escape(title) + "</b><br><br>" : "") + (body || " ") },
    media, replyTo: root ? undefined : key(data.tid),
    repliesCount: root ? number(data.thread.replies) : undefined,
    url: ORIGIN + "/read.php?tid=" + data.tid + (root ? "" : "&pid=" + str(row.pid)),
    sourceChannel: root && str(data.forum?.name) ? { id: str(data.thread.fid), name: str(data.forum?.name) } : undefined,
    sourceLanguages: LANGUAGE,
  };
}

function user(uid: string | undefined, value: unknown, profile?: Row): ProfileV1 | undefined {
  if (!uid) return undefined;
  const name = str(value).trim() || "UID " + uid;
  return {
    key: key(uid), handle: uid, displayName: name,
    avatarUrl: avatarUrl(str(profile?.avatar)) ?? AVATAR_PLACEHOLDER,
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
