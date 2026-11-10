import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../plugin.js", import.meta.url), "utf8");
const page = { direction: "refresh", limit: 20 };
const guest = { scope: "guest", credentialAvailable: false };
const account = { scope: "account", credentialAvailable: true };

function register(respond, { supportsMatchAll = true } = {}) {
  let plugin;
  const requests = [];
  const prelude = supportsMatchAll ? "" : "String.prototype.matchAll = undefined;\n";
  vm.runInNewContext(prelude + source, {
    defineFlareSocialPlugin(value) { plugin = value; },
    flare: {
      error: ({ code, message }) => Object.assign(new Error(message.value), { code }),
      credential: { read: async () => ({ cookies: [{ name: "ngaPassportUid", value: "123" }] }) },
      http: {
        request: async (request) => {
          const url = new URL(request.url);
          requests.push({ ...request, url });
          const data = respond(url, request);
          return { status: 200, headers: {}, body: typeof data === "string" ? data : JSON.stringify(data) };
        },
      },
    },
  });
  return { ...plugin.capabilities, requests };
}

test("topic list shows actual board, reply count and latest reply time without loading avatars", async () => {
  const { timeline, requests } = register(() => ({ data: {
    __F: { name: "DOTA2", sub_forums: { 574: [574, "精华区"] } },
    __T: [
      { tid: 1, fid: 321, author: "A", subject: "First", replies: 0, postdate: 1700000000 },
      { tid: 2, fid: 521, parent: { 2: "DOTA2杂谈" }, author: "B", subject: "A &amp; B", replies: 7,
        lastpost: 1700000100, postdate: 1700000000 },
      { tid: 3, fid: 574, quote_from: 4, subject: "Quote" },
      { tid: 5, fid: 635, parent: { 2: "版面镜像" }, topic_misc_var: { 3: 521 }, subject: "DOTA2杂谈" },
    ],
  } }));
  const result = await timeline.page({ timelineId: "forum-321", parameters: { fid: "321" }, page }, account);
  assert.ok(result.items.every(({ type, feed }) => type === "feed" && feed.source.iconUrl === undefined));
  const [parent, child, copied, mirror] = result.items.map(({ feed }) => feed);
  assert.equal(parent.source.name, "DOTA2");
  assert.equal(parent.description.value, "A · 0 条回复");
  assert.equal(parent.createdAt, new Date(1700000000000).toISOString());
  assert.equal(child.source.name, "DOTA2杂谈");
  assert.equal(child.title, "A & B");
  assert.equal(child.description.value, "B · 7 条回复");
  assert.equal(child.createdAt, new Date(1700000100000).toISOString());
  assert.equal(child.target.type, "post");
  assert.equal(child.target.key.id, "2");
  assert.equal(copied.source.name, "精华区");
  assert.equal(copied.target.key.id, "4");
  assert.equal(mirror.source.name, "版面镜像");
  assert.equal(mirror.target.url, "https://bbs.nga.cn/thread.php?fid=521");
  assert.equal(requests.length, 1);
});

test("thread detail loads a missing signed-in author's avatar and renders the original post first", async () => {
  const { post, requests } = register((url) => url.pathname === "/nuke.php"
    ? { code: 0, result: [{ uid: 40749600, avatar: "/*$js$*/" + JSON.stringify({ 0: ".a/40749600_123.png" }) }] }
    : { data: {
        __T: { tid: 2, authorid: 40749600, author: "A", subject: "Original post" },
        __R: [{ lou: 0, pid: 10, content: "Original body" }, { lou: 1, pid: 11, authorid: 42, content: "Reply" }],
        __U: { 42: { username: "B", avatar: "broken%7C//img4.nga.cn/ngabbs/face/a_arcane.webp" } },
      } });
  const key = { id: "2", host: "bbs.nga.cn" };
  const anonymous = await post.detail({ key }, guest);
  assert.equal(anonymous.post.author.displayName, "A");
  assert.equal(anonymous.post.author.avatarUrl, undefined);
  assert.equal(requests.length, 1);
  const loggedIn = await post.detail({ key }, account);
  assert.equal(loggedIn.post.author.avatarUrl, "https://img.nga.cn/avatars/2002/a20/6dc/002/40749600_123.png");
  assert.equal(requests.filter(({ url }) => url.pathname === "/nuke.php").length, 1);
  const thread = await post.context({ key, page }, guest);
  assert.equal(thread.items[0].post.key.id, "2");
  assert.match(thread.items[0].post.content.value, /Original body/);
  assert.equal(thread.items[1].post.replyTo, undefined);
  assert.equal(thread.items[1].post.author.avatarUrl, "https://img4.nga.cn/ngabbs/face/a_arcane.webp");
});

test("reply text stays ahead of a compact quote on runtimes without matchAll", async () => {
  const quote = "[pid=10,2,1]Reply[/pid] [b]Post by [uid=42]B[/uid] (2026-11-10 00:32):[/b]";
  const root = { lou: 0, pid: 0, authorid: 40749600, content: "Original body" };
  const original = { lou: 1, pid: 10, authorid: 42, content: "原楼层正文" };
  const reply = { lou: 2, pid: 11, authorid: 43, content: "[quote]" + quote + "<br/><br/>" +
    "引用内容".repeat(35) + "[img]./quoted.png[/img][/quote]<br/><br/>这层自己的[del]文字[/del][s:ac:哭笑]" +
    "<br/><br/>[img]./reply.png[/img]" };
  const direct = { lou: 3, pid: 12, authorid: 43, content: "[b]Reply to " + quote.replace("[b]", "") +
    "<br/>直接回复正文[quote]没有楼层链接的引用[/quote]" };
  const { post, requests } = register(() => ({ data: {
    __T: { tid: 2, authorid: 40749600, author: "A", subject: "Original post" },
    __R: [root, original, reply, direct],
    __U: { 42: { username: "B", avatar: "a_sheep.png" }, 43: { username: "C" } },
    __GLOBAL: { _ATTACH_BASE_VIEW: "img.nga.cn/attachments" },
  } }), { supportsMatchAll: false });
  const result = await post.context({ key: { id: "2", host: "bbs.nga.cn" }, page }, guest);
  const [, , replyItem, directItem] = result.items;
  assert.equal(replyItem.post.content.value, "这层自己的<del>文字</del>（哭笑）");
  assert.equal(replyItem.post.media.length, 1);
  assert.equal(replyItem.post.media[0].url, "https://img.nga.cn/attachments/reply.png");
  const [preview] = replyItem.presentation.quotes;
  assert.equal(preview.author.displayName, "B");
  assert.equal(preview.author.avatarUrl, "https://img4.nga.cn/ngabbs/face/a_sheep.png");
  assert.equal(preview.createdAt, "2026-11-09T16:32:00.000Z");
  assert.notEqual(preview.key.id, "p2-10-1");
  assert.equal(preview.detailType, "link");
  assert.equal(preview.url, "https://bbs.nga.cn/read.php?tid=2&pid=10");
  assert.match(preview.content.value, /…$/);
  assert.equal(preview.content.value.length, 97);
  assert.match(directItem.post.content.value, /^直接回复正文.*<blockquote>没有楼层链接的引用<\/blockquote>/);
  assert.equal(directItem.presentation.quotes[0].content.value, original.content);
  assert.equal(requests.length, 1);
  const opened = await post.context({ key: { id: "p2-10-1", host: "bbs.nga.cn" }, page }, guest);
  assert.equal(opened.items[0].post.content.value, original.content);
});

test("a rejected Host HTTP request returns a recoverable network error", async () => {
  const { post, requests } = register(() => { throw new Error("Host transport reset"); });
  const key = { id: "2", host: "bbs.nga.cn" };
  await assert.rejects(post.context({ key, page }, guest), { code: "Network", message: "连接 NGA 失败，请重试" });
  assert.equal(requests[0].timeoutMillis, 8_000);
});

test("truncated web JSON falls back to the matching page of NGA's app thread API", async () => {
  const { post, requests } = register((url, request) => {
    if (url.pathname === "/read.php") return '{"data":{"__R":[{"content":"unfinished';
    assert.equal(url.pathname, "/app_api.php");
    assert.equal(url.searchParams.get("__act"), "list");
    assert.equal(request.method, "POST");
    assert.equal(request.body.type, "form");
    assert.equal(request.body.values.tid, "47850087");
    const currentPage = Number(request.body.values.page);
    const author = { uid: 66529948, username: "UID:66529948", avatar: "a_arcane.webp" };
    return { code: 0, msg: "操作成功", currentPage, perPage: 2, vrows: 3, fid: 510343,
      forum_name: "赛车俱乐部", tsubject: "赛车帖子", tauthor: "mczhao2025", tauthorid: author.uid,
      attachPrefix: "https://img.nga.cn/attachments/",
      result: currentPage === 1 ? [
        { tid: 47850087, pid: 0, lou: 0, author, content: '<a href="javascript:;">正文</a>[img]./race.jpg[/img]' },
        { tid: 47850087, pid: 10, lou: 1, author, content: "第一条回复" },
      ] : [{ tid: 47850087, pid: 11, lou: 2, author, content: "第二条回复" }],
    };
  });
  const key = { id: "47850087", host: "bbs.nga.cn" };
  const detail = await post.detail({ key }, account);
  assert.match(detail.post.content.value, /赛车帖子.*正文/);
  assert.doesNotMatch(detail.post.content.value, /javascript:/);
  assert.equal(detail.post.media[0].url, "https://img.nga.cn/attachments/race.jpg");
  assert.equal(detail.post.author.displayName, "mczhao2025");
  assert.equal(detail.post.repliesCount, 2);
  assert.equal(detail.post.sourceChannel.name, "赛车俱乐部");
  const first = await post.context({ key, page }, account);
  assert.equal(first.items.length, 2);
  assert.equal(first.olderCursor, "2:0");
  const next = await post.context({ key, page: { ...page, direction: "older", cursor: first.olderCursor } }, account);
  assert.equal(next.items[0].post.content.value, "第二条回复");
  assert.equal(next.endReached, true);
  assert.equal(requests.length, 6);
  assert.ok(requests.every(({ cookies }) => cookies[0]?.name === "ngaPassportUid"));
});

test("a permission error is surfaced without using the backup thread API", async () => {
  const { post, requests } = register(() => ({ error: ["2048:请登录后访问"] }));
  const key = { id: "47850087", host: "bbs.nga.cn" };
  await assert.rejects(post.detail({ key }, guest), { code: "AuthenticationRequired" });
  assert.equal(requests.length, 1);
});

test("catalog includes official boards and their independent subforums while skipping topic shortcuts", async () => {
  const { tabCatalog, requests } = register((url) => {
    if (url.searchParams.get("__act") === "get_all_forums") return { data: [{ all: {
      club: { name: "社区事务", content: [{ name: "合集", content: [
        { fid: 781, name: "合集事务" }, { fid: "510343", name: "赛车俱乐部" }, { fid: 830, name: "极限竞速" },
        { fid: 781, name: "帖子捷径", stid: 123 }, { fid: "-5944654", name: "ASOUL综合讨论" },
      ] }] },
    } }] };
    const fid = url.searchParams.get("fid");
    const forums = {
      321: { name: "DOTA2", sub_forums: { 521: [521, "DOTA2杂谈"], 574: [574, "精华区"], t40146107: [40146107, "档案馆"] } },
      510343: { name: "赛车俱乐部", sub_forums: { 830: [830, "极限竞速:地平线系列"], t33237742: [33237742, "F1 车队经理"] } },
    };
    return { data: { __F: forums[fid] ?? {} } };
  });
  const first = await tabCatalog.page(page, account);
  const dota = first.items.find(({ id }) => id === "sub-321");
  assert.equal(dota.timelines.items.length, 2);
  assert.equal(dota.timelines.items[0].title.value, "DOTA2 · DOTA2杂谈");
  assert.equal(dota.timelines.items[0].parameters.fid, "521");
  assert.equal(dota.timelines.items[1].parameters.fid, "574");
  const boards = first.items.flatMap(({ timelines }) => timelines.items);
  assert.equal(boards.find(({ parameters }) => parameters.fid === "510343").title.value, "赛车俱乐部");
  assert.equal(boards.filter(({ parameters }) => parameters.fid === "830").length, 1);
  assert.ok(boards.some(({ parameters }) => parameters.fid === "-5944654"));
  assert.ok(!boards.some(({ title }) => title.value === "帖子捷径" || title.value.includes("F1 车队经理")));
  assert.equal(requests.find(({ url }) => url.searchParams.get("__act") === "get_all_forums").cookies.length, 0);
  assert.equal(first.olderCursor, "subboards:4");
  await tabCatalog.page({ direction: "older", limit: 20, cursor: first.olderCursor }, account);
  assert.ok(requests.some(({ url }) => url.searchParams.get("fid") === "310"));
  assert.equal(requests.filter(({ url }) => url.searchParams.get("fid") === "321").length, 1);
});
