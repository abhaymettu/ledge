import fs from "node:fs"; import os from "node:os"; import crypto from "node:crypto"; import https from "node:https";
// App Store Connect helper for release.sh: `builds` lists the newest three, `assign <buildId>`
// adds one to the Internal TestFlight group. Reads ~/.ledge/asc.json ({issuerId, keyId,
// appId, internalGroupId}) and ~/.appstoreconnect/private_keys/AuthKey_<keyId>.p8.
// Node built-ins only.
const a = JSON.parse(fs.readFileSync(os.homedir() + "/.ledge/asc.json", "utf8"));
const key = fs.readFileSync(`${os.homedir()}/.appstoreconnect/private_keys/AuthKey_${a.keyId}.p8`);
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const h = b64({ alg: "ES256", kid: a.keyId, typ: "JWT" }), p = b64({ iss: a.issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" });
const jwt = h + "." + p + "." + crypto.sign("sha256", Buffer.from(h + "." + p), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
const api = (method, path, body) => new Promise((res, rej) => {
  const r = https.request("https://api.appstoreconnect.apple.com" + path, { method, headers: { authorization: "Bearer " + jwt, "content-type": "application/json" } }, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => res({ status: r.statusCode, body: d ? JSON.parse(d) : null })); });
  r.on("error", rej); if (body) r.write(JSON.stringify(body)); r.end();
});
const cmd = process.argv[2];
if (cmd === "builds") {
  const { body } = await api("GET", `/v1/builds?filter[app]=${a.appId}&sort=-uploadedDate&limit=3&fields[builds]=version,processingState,uploadedDate`);
  for (const b of body.data) console.log(b.id, "build", b.attributes.version, b.attributes.processingState, b.attributes.uploadedDate);
} else if (cmd === "assign") {
  const id = process.argv[3];
  const r = await api("POST", `/v1/betaGroups/${a.internalGroupId}/relationships/builds`, { data: [{ type: "builds", id }] });
  console.log("assign", r.status, r.body ? JSON.stringify(r.body).slice(0, 200) : "");
}
