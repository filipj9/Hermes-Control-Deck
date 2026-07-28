import crypto from "node:crypto";

console.log(crypto.randomBytes(32).toString("hex"));
