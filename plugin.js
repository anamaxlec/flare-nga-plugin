"use strict";
(() => {
  // src/plugin.ts
  var HOST = "bbs.nga.cn";
  var ORIGIN = "https://" + HOST;
  var LOGIN = "/nuke.php?__lib=login&__act=account&login";
  var SESSION = "/nuke.php?__lib=noti&__act=if";
  var CAPS = {
    "flare.datasource.timeline/v1": ["page"],
    "flare.datasource.tab-catalog/v1": ["page"],
    "flare.datasource.post/v1": ["detail", "context"],
    "flare.datasource.profile/v1": ["byId", "byHandle"]
  };
  var LANGUAGE = ["zh-CN"];
  var AVATAR_PLACEHOLDER = "https://img4.nga.cn/ngabbs/face/a_sheep.png";
  var SUBBOARD_BATCH_SIZE = 4;
  var BOARDS = [
    { name: "\u6E38\u620F\u8BA8\u8BBA", forums: [
      ["7", "\u827E\u6CFD\u62C9\u65AF\u8BAE\u4E8B\u5385"],
      ["310", "\u7CBE\u82F1\u8BAE\u4F1A"],
      ["510569", "\u9B54\u517D\u4E16\u754C\uFF1A\u65E0\u9650"],
      ["-152678", "\u82F1\u96C4\u8054\u76DF"],
      ["321", "DOTA2"],
      ["459", "\u5B88\u671B\u5148\u950B"],
      ["489", "\u602A\u7269\u730E\u4EBA"],
      ["428", "\u624B\u6E38\u8BA8\u8BBA"],
      ["650", "\u539F\u795E"],
      ["-34587507", "\u660E\u65E5\u65B9\u821F"],
      ["538", "\u9634\u9633\u5E08"]
    ] },
    { name: "\u7EFC\u5408\u4EA4\u6D41", forums: [
      ["-7", "\u7F51\u4E8B\u6742\u8C08"],
      ["-447601", "\u4E8C\u6B21\u5143\u56FD\u5BB6\u5730\u7406"],
      ["334", "\u786C\u4EF6\u914D\u7F6E"],
      ["436", "\u6D88\u8D39\u7535\u5B50 IT\u65B0\u95FB"],
      ["-576177", "\u97F3\u4E50\u5F71\u89C6"]
    ] }
  ];
  var SUBBOARD_PARENTS = [.../* @__PURE__ */ new Set([
    "7",
    "321",
    "650",
    "-447601",
    ...BOARDS.flatMap(({ forums }) => forums.map(([fid]) => fid))
  ])];
  defineFlareSocialPlugin({
    detector: {
      detect({ origin }) {
        if (![ORIGIN, "https://ngabbs.com", "https://nga.178.com"].includes(origin)) {
          return { match: "none", canonicalOrigin: origin };
        }
        return { match: "exact", canonicalOrigin: ORIGIN, software: "NGA", instance: { domain: HOST, title: "NGA \u73A9\u5BB6\u793E\u533A" } };
      }
    },
    login: {
      browser: {
        begin() {
          return { type: "webCookie", startUrl: ORIGIN + LOGIN };
        },
        async check(request) {
          const cookies = request.cookies.cookies.filter(({ sourceUrl }) => sourceUrl === ORIGIN + SESSION + "&__output=11").map(({ name, value }) => ({ name, value }));
          const accountId = numeric(cookies.find(({ name }) => name === "ngaPassportUid")?.value);
          if (!accountId || !cookies.some(({ name, value }) => name === "ngaPassportCid" && value)) return { type: "pending" };
          const response = await get(SESSION, cookies);
          if (response.status !== 200 || response.root?.error || response.root?.data == null) return { type: "pending" };
          const found = await accountProfile(accountId, cookies).catch(() => void 0);
          const profile = user(accountId, found?.username ?? "", found) ?? { key: key(accountId), handle: accountId, displayName: "NGA \u7528\u6237 " + accountId };
          return { type: "success", value: { accountId, origin: ORIGIN, profile, credential: { cookies }, capabilities: CAPS } };
        }
      }
    },
    capabilities: {
      timeline: {
        async page(request, context) {
          const fid = forumId(request.parameters?.fid ?? request.page.parameters?.fid);
          if (fid === void 0) fail("Validation", "\u6CA1\u6709\u6307\u5B9A NGA \u7248\u9762");
          const position = cursor(request.page);
          const cookies = await cookiesFor(context);
          const data = await api("/thread.php?fid=" + fid + "&page=" + position.batch, context, cookies);
          const users = obj(data.__U);
          const forum = obj(data.__F);
          const name = str(forum?.name) || BOARDS.flatMap(({ forums }) => [...forums]).find(([id]) => id === fid)?.[1];
          const topics = rows(data.__T);
          const items = topics.flatMap((thread) => {
            const tid = numeric(thread.tid);
            if (!tid || position.batch > 1 && (Number(thread.type) & 5120) !== 0) return [];
            return [{ type: "post", post: preview(thread, tid, str(name), obj(users?.[str(thread.authorid)])) }];
          });
          const total = number(data.__ROWS);
          const batchSize = number(data.__T__ROWS_PAGE) ?? 35;
          const result = slice(items, request.page, position, topics.length > 0 && total !== void 0 && position.batch * batchSize < total);
          if (cookies.length) await loadListAvatars(result.items ?? [], cookies);
          return result;
        }
      },
      tabCatalog: {
        async page(request, context) {
          const offset = request.direction === "refresh" ? 0 : number(/^subboards:(\d+)$/.exec(request.cursor ?? "")?.[1]);
          if (offset === void 0 || request.direction === "newer") return { items: [], endReached: true };
          const sections = offset === 0 ? BOARDS.map(({ name, forums }, index) => ({
            id: "group-" + index,
            title: { value: name },
            timelines: { items: forums.map(([fid, name2]) => board(fid, name2)), endReached: true }
          })) : [];
          const parents = SUBBOARD_PARENTS.slice(offset, offset + SUBBOARD_BATCH_SIZE);
          const cookies = await cookiesFor(context);
          const children = await Promise.all(parents.map(async (fid) => {
            const data = await api("/thread.php?fid=" + fid + "&page=1", context, cookies).catch(() => void 0);
            const forum = obj(data?.__F);
            const name = str(forum?.name) || BOARDS.flatMap(({ forums }) => [...forums]).find(([id]) => id === fid)?.[1];
            if (!name) return void 0;
            const items = Object.entries(obj(forum?.sub_forums) ?? {}).flatMap(([entry, value]) => {
              const row = list(value);
              const childId = forumId(entry);
              const childName = str(row[1]).trim();
              return childId && childId !== fid && childName ? [board(childId, name + " \xB7 " + childName, fid)] : [];
            });
            return items.length ? {
              id: "sub-" + fid,
              title: { value: name },
              timelines: { items, endReached: true }
            } : void 0;
          }));
          for (const section of children) if (section) sections.push(section);
          const next = offset + parents.length;
          const endReached = next >= SUBBOARD_PARENTS.length;
          return { items: sections, olderCursor: endReached ? void 0 : "subboards:" + next, endReached };
        }
      },
      profile: {
        async byId({ key: { id } }, context) {
          const uid = numeric(id);
          if (!uid) fail("NotFound", "\u627E\u4E0D\u5230\u8FD9\u4E2A NGA \u7528\u6237");
          const profile = await accountProfile(uid, await cookiesFor(context));
          return publicProfile(profile);
        },
        async byHandle({ handle }, context) {
          const cookies = await cookiesFor(context);
          const uid = numeric(handle);
          if (uid) return publicProfile(await accountProfile(uid, cookies));
          const { root } = await get("/nuke.php?__lib=ucp&__act=get&username=" + encodeURIComponent(handle), cookies, 14);
          return publicProfile(rows(root?.result)[0]);
        }
      },
      post: {
        async detail({ key: { id } }, context) {
          return { post: await loadPost(id, context) };
        },
        async context({ key: { id }, page }, context) {
          const ref = postRef(id);
          if (ref.pid) {
            const items2 = page.direction === "refresh" ? [{ type: "post", post: await loadPost(id, context) }] : [];
            return { items: items2, endReached: true };
          }
          const position = cursor(page);
          const data = await loadThread(ref.tid, position.batch, context);
          const items = data.replies.flatMap((row) => {
            const pid = numeric(row.pid);
            if (!pid && number(row.lou) !== 0) return [];
            const keyId = pid ? "p" + ref.tid + "-" + pid + "-" + position.batch : ref.tid;
            if (keyId === ref.tid && position.batch !== 1) return [];
            return [{ type: "post", post: floor(row, data, keyId) }];
          });
          return slice(items, page, position, data.hasMore);
        }
      }
    }
  });
  function board(fid, name, parent) {
    const id = parent ? "forum-" + parent + "-sub-" + fid : "forum-" + fid;
    return { id, title: { value: name }, icon: "Channel", parameters: { fid } };
  }
  async function get(path, cookies, output = 11, timeoutMillis) {
    const response = await flare.http.request({
      url: ORIGIN + path + "&__output=" + output,
      cookies,
      timeoutMillis,
      headers: {
        Accept: "application/json",
        Referer: ORIGIN + "/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
      }
    });
    let root;
    try {
      root = obj(JSON.parse(response.body));
    } catch {
    }
    return { status: response.status, root };
  }
  async function api(path, context, cookies) {
    let result = await get(path, cookies ?? await cookiesFor(context));
    if (context.scope === "guest" && str(list(result.root?.error)[0]).startsWith("15:")) {
      const script = str(list(result.root?.error)[1]);
      const guest = /document\.cookie\s*=\s*'guestJs=(\d{1,14}_[a-z0-9]{1,64});/i.exec(script)?.[1];
      if (guest) result = await get(path + "&rand=" + Date.now(), [{ name: "guestJs", value: guest }]);
    }
    const { status, root } = result;
    const data = obj(root?.data);
    const details = data?.__MESSAGE;
    const message = str(list(root?.error)[0]) || str(root?.msg) || str(list(details)[1] ?? obj(details)?.["1"]);
    if (status === 401 || status === 403 || /未登录|先登录|访客|权限/.test(message)) {
      fail("AuthenticationRequired", message || "\u8BF7\u767B\u5F55 NGA \u6216\u68C0\u67E5\u7248\u9762\u6743\u9650");
    }
    if (status === 404 || /帖子不存在|主题不存在|找不到/.test(message)) fail("NotFound", message || "NGA \u9875\u9762\u4E0D\u5B58\u5728");
    if (status === 429) fail("RateLimited", "NGA \u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41");
    if (status >= 400 || message) fail("Remote", message || "NGA \u6682\u65F6\u65E0\u6CD5\u8FD4\u56DE\u6570\u636E");
    if (!data) fail("InvalidResponse", "NGA \u6CA1\u6709\u8FD4\u56DE\u53EF\u8BFB\u53D6\u7684\u6570\u636E");
    return data;
  }
  async function cookiesFor(context) {
    if (context.scope !== "account" || !context.credentialAvailable) return [];
    return list(obj(await flare.credential.read())?.cookies).flatMap((entry) => {
      const value = obj(entry);
      const name = str(value?.name);
      const cookie = str(value?.value);
      return name && cookie ? [{ name, value: cookie }] : [];
    });
  }
  async function accountProfile(uid, cookies, timeoutMillis) {
    const { root } = await get("/nuke.php?__lib=ucp&__act=get&uid=" + uid, cookies, 14, timeoutMillis);
    return rows(root?.result).find((profile) => numeric(profile.uid) === uid);
  }
  async function loadListAvatars(items, cookies) {
    const authors = /* @__PURE__ */ new Map();
    for (const item of items) {
      if (item.type !== "post" || item.post.author?.avatarUrl !== AVATAR_PLACEHOLDER) continue;
      const author = item.post.author;
      const id = author.key.id;
      const group = authors.get(id) ?? [];
      group.push(author);
      authors.set(id, group);
    }
    const pending = [...authors].slice(0, 20);
    for (let offset = 0; offset < pending.length; offset += 5) {
      await Promise.all(pending.slice(offset, offset + 5).map(async ([uid, profiles]) => {
        const user2 = await accountProfile(uid, cookies, 2e3).catch(() => void 0);
        const url = avatarUrl(str(user2?.avatar));
        if (url) for (const profile of profiles) profile.avatarUrl = url;
      }));
    }
  }
  function publicProfile(row) {
    const profile = user(numeric(row?.uid), row?.username, row);
    if (!profile) fail("NotFound", "\u627E\u4E0D\u5230\u8FD9\u4E2A NGA \u7528\u6237");
    return profile;
  }
  async function loadThread(tid, batch, context) {
    const data = await api("/read.php?tid=" + tid + "&page=" + batch, context);
    const thread = obj(data.__T);
    const replies = rows(data.__R);
    if (!thread || !replies.length) fail("NotFound", "\u627E\u4E0D\u5230\u8FD9\u7BC7\u5E16\u5B50\u6216\u697C\u5C42");
    const size = number(data.__R__ROWS_PAGE) ?? 20;
    const total = number(data.__ROWS);
    return {
      tid,
      batch,
      thread,
      replies,
      users: obj(data.__U) ?? {},
      forum: obj(data.__F),
      attachmentHost: str(obj(data.__GLOBAL)?._ATTACH_BASE_VIEW),
      hasMore: total !== void 0 ? batch * size < total : replies.length >= size
    };
  }
  async function loadPost(id, context) {
    const { tid, pid, batch } = postRef(id);
    const thread = await loadThread(tid, batch, context);
    const row = thread.replies.find((row2) => pid ? numeric(row2.pid) === pid : number(row2.lou) === 0);
    if (!row) fail("NotFound", "\u627E\u4E0D\u5230\u8FD9\u4E2A\u697C\u5C42");
    return floor(row, thread, id);
  }
  function postRef(id) {
    if (numeric(id)) return { tid: id, batch: 1, pid: void 0 };
    const reply = /^p(\d+)-(\d+)-(\d+)$/.exec(id);
    if (!reply) fail("NotFound", "\u65E0\u6CD5\u8BC6\u522B\u8FD9\u4E2A\u5E16\u5B50");
    return { tid: reply[1], pid: reply[2], batch: Number(reply[3]) };
  }
  function preview(thread, tid, forum, profile) {
    const title = str(thread.subject);
    return {
      key: key(tid),
      author: user(numeric(thread.authorid), thread.author, profile),
      createdAt: time(thread.postdate),
      content: { format: "html", value: "<b>" + escape(title) + "</b>" },
      repliesCount: number(thread.replies),
      url: ORIGIN + "/read.php?tid=" + tid,
      sourceChannel: forum ? { id: str(thread.fid), name: forum } : void 0,
      sourceLanguages: LANGUAGE
    };
  }
  function floor(row, data, id) {
    const root = data.tid === id;
    const uid = numeric(row.authorid);
    const author = obj(uid ? data.users[uid] : void 0);
    const name = row.author || (root ? data.thread.author : "") || author?.username;
    const media = [];
    const title = root ? str(data.thread.subject || row.subject) : "";
    const body = str(row.content).replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/\[img(?:=[^\]]*)?\]([^\[]+)\[\/img\]/gi, (_, source) => {
      const url = mediaUrl(source, data.attachmentHost);
      if (url && media.length < 12 && !media.some((image) => image.url === url)) {
        media.push({ id: id + "-m" + media.length, type: /\.gif(?:$|[?#])/i.test(url) ? "gif" : "image", url });
      }
      return "";
    }).replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_, source, title2) => {
      const url = https(source);
      return url ? '<a href="' + escape(url) + '">' + title2 + "</a>" : title2;
    }).replace(/\[\/?(?:quote|b|i|u|s)(?:=[^\]]*)?\]/gi, (tag) => tag.toLowerCase().replace("quote", "blockquote").replace(/\[|\]/g, (ch) => ch === "[" ? "<" : ">").replace(/=[^>]+/, "")).replace(/\[\/?(?:size|font|color|align|collapse)(?:=[^\]]*)?\]/gi, "").replace(/(?:<br\s*\/?\s*>\s*){3,}/gi, "<br><br>").trim();
    return {
      key: key(id),
      author: user(uid, name, author),
      createdAt: time(row.postdatetimestamp),
      content: { format: "html", value: (title ? "<b>" + escape(title) + "</b><br><br>" : "") + (body || " ") },
      media,
      replyTo: root ? void 0 : key(data.tid),
      repliesCount: root ? number(data.thread.replies) : void 0,
      url: ORIGIN + "/read.php?tid=" + data.tid + (root ? "" : "&pid=" + str(row.pid)),
      sourceChannel: root && str(data.forum?.name) ? { id: str(data.thread.fid), name: str(data.forum?.name) } : void 0,
      sourceLanguages: LANGUAGE
    };
  }
  function user(uid, value, profile) {
    if (!uid) return void 0;
    const name = str(value).trim() || "UID " + uid;
    return {
      key: key(uid),
      handle: uid,
      displayName: name,
      avatarUrl: avatarUrl(str(profile?.avatar)) ?? AVATAR_PLACEHOLDER,
      followersCount: number(profile?.follow_by_num),
      url: ORIGIN + "/nuke.php?__lib=ucp&__act=get&uid=" + uid
    };
  }
  function avatarUrl(value) {
    let candidates;
    if (value.startsWith("/*$js$*/")) {
      try {
        candidates = Object.values(obj(JSON.parse(value.slice(8))) ?? {});
      } catch {
        return void 0;
      }
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
        return "https://img.nga.cn/avatars/2002/" + shard.slice(6) + "/" + shard.slice(3, 6) + "/" + shard.slice(0, 3) + "/" + short[1] + "_" + short[2];
      }
      if (/^[a-z\d_%-]+\.(?:jpe?g|png|gif|webp)$/i.test(entry)) {
        return "https://img4.nga.cn/ngabbs/face/" + entry;
      }
    }
    return void 0;
  }
  function cursor(page) {
    if (page.direction === "refresh") return { batch: 1, skip: 0 };
    const match = /^(\d+):(\d+)$/.exec(page.cursor ?? "");
    if (page.direction !== "older" || !match || !numeric(match[1]) || !Number.isSafeInteger(Number(match[2]))) fail("Validation", "\u5206\u9875\u4F4D\u7F6E\u65E0\u6548");
    return { batch: Number(match[1]), skip: Number(match[2]) };
  }
  function slice(rows2, page, position, hasMore) {
    const end = position.skip + page.limit;
    const olderCursor = end < rows2.length ? position.batch + ":" + end : hasMore ? position.batch + 1 + ":0" : void 0;
    return { items: rows2.slice(position.skip, end), olderCursor, endReached: !olderCursor };
  }
  function mediaUrl(value, attachmentHost) {
    const path = value.trim();
    if (path.startsWith("./") && /^[a-z\d.-]+\.nga\.cn\/attachments$/i.test(attachmentHost)) {
      return https("https://" + attachmentHost + "/" + path.slice(2));
    }
    return https(path);
  }
  function https(value) {
    const url = value.trim().replace(/&amp;/g, "&").replace(/^http:/i, "https:").replace(/^\/\//, "https://");
    return /^https:\/\/[a-z\d.-]+(?::\d+)?(?:[/?#]|$)/i.test(url) && !/[\s<>"']/u.test(url) ? url : void 0;
  }
  function rows(value) {
    return (Array.isArray(value) ? value : Object.values(obj(value) ?? {})).map(obj).filter((row) => row !== void 0);
  }
  function obj(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }
  function list(value) {
    return Array.isArray(value) ? value : [];
  }
  function str(value) {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
  function numeric(value) {
    const id = str(value);
    return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : void 0;
  }
  function number(value) {
    const id = str(value);
    return /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : void 0;
  }
  function forumId(value) {
    const id = str(value);
    return /^-?\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? id : void 0;
  }
  function time(value) {
    const n = number(value);
    return n && n < 1e10 ? new Date(n * 1e3).toISOString() : "1970-01-01T00:00:00.000Z";
  }
  function key(id) {
    return { id, host: HOST };
  }
  function escape(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fail(code, message) {
    throw flare.error({ code, message: { value: message } });
  }
})();
