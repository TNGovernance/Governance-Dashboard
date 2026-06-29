import { handleAdminSession } from "../../lib/backend.mjs";

export default async function handler(req, res) {
  await handleAdminSession(req, res);
}
