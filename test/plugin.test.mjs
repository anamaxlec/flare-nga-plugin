import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../plugin.js", import.meta.url), "utf8");
const fallback = "https://img4.nga.cn/ngabbs/face/a_sheep.png";
const page = { direction: "refresh", limit: 20 };
const guest = { scope: "guest", credentialAvailable: false };
const account = { scope: "account", credentialAvailable: true };

function register(respond) {
  let plugin;
  const requests = [];
  vm.runInNewContext(source, {
    defineFlareSocialPlugin(value) { plugin = value; },
    flare: {
      error: ({ code, message }) => Object.assign(new Error(message.value), { code }),
      credential: { read: async () => ({ cookies: [{ name: "ngaPassportUid", value: "123" }] }) },
      http: {
        request: async (request) => {
          const url = new URL(request.url);
          requests.push({ url, cookies: request.cookies });
          return { status: 200, headers: {}, body: JSON.stringify(respond(url)) };
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
  assert.equal(anonymous.post.author.avatarUrl, fallback);
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
