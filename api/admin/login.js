import { handleAdminLogin } from "../../lib/backend.mjs";

export default async function handler(req, res) {
  await handleAdminLogin(req, res);
}
