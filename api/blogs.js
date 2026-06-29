import { handleBlogsRequest } from "../lib/backend.mjs";

export default async function handler(req, res) {
  await handleBlogsRequest(req, res);
}
