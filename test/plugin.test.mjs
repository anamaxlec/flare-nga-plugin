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

test("timeline uses available NGA avatars, loads missing ones for signed-in users and keeps a guest placeholder", async () => {
  const { timeline, requests } = register((url) => url.pathname === "/nuke.php"
    ? { code: 0, result: [{ uid: 40749600, avatar: "/*$js$*/" + JSON.stringify({ 0: ".a/40749600_123.png" }) }] }
    : { data: {
        __T: [
          { tid: 1, authorid: 40749600, author: "A", subject: "First" },
          { tid: 2, authorid: 40749600, author: "A", subject: "Second" },
          { tid: 3, authorid: 42, author: "B", subject: "Third" },
        ],
        __U: { 42: { avatar: "broken%7C//img4.nga.cn/ngabbs/face/a_arcane.webp" } },
      } });
  const request = { timelineId: "forum-321", parameters: { fid: "321" }, page };
  const anonymous = await timeline.page(request, guest);
  assert.equal(anonymous.items[0].post.author.avatarUrl, fallback);
  assert.equal(anonymous.items[2].post.author.avatarUrl, "https://img4.nga.cn/ngabbs/face/a_arcane.webp");
  assert.equal(requests.length, 1);
  const loggedIn = await timeline.page(request, account);
  assert.equal(loggedIn.items[0].post.author.avatarUrl, "https://img.nga.cn/avatars/2002/a20/6dc/002/40749600_123.png");
  assert.equal(loggedIn.items[0].post.author.avatarUrl, loggedIn.items[1].post.author.avatarUrl);
  assert.equal(requests.filter(({ url }) => url.pathname === "/nuke.php").length, 1);
});

test("catalog exposes independent DOTA2 subforums and does not mistake topic shortcuts for forums", async () => {
  const { tabCatalog, requests } = register((url) => ({ data: { __F: url.searchParams.get("fid") === "321"
    ? { name: "DOTA2", sub_forums: { 521: [521, "DOTA2杂谈"], 574: [574, "精华区"], t40146107: [40146107, "档案馆"] } }
    : {} } }));
  const first = await tabCatalog.page(page, account);
  const dota = first.items.find(({ id }) => id === "sub-321");
  assert.equal(dota.timelines.items.length, 2);
  assert.equal(dota.timelines.items[0].title.value, "DOTA2 · DOTA2杂谈");
  assert.equal(dota.timelines.items[0].parameters.fid, "521");
  assert.equal(dota.timelines.items[1].parameters.fid, "574");
  assert.equal(first.olderCursor, "subboards:4");
  await tabCatalog.page({ direction: "older", limit: 20, cursor: first.olderCursor }, account);
  assert.ok(requests.some(({ url }) => url.searchParams.get("fid") === "310"));
  assert.equal(requests.filter(({ url }) => url.searchParams.get("fid") === "321").length, 1);
});
