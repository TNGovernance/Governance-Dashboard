import { handleAssemblyNewsRequest } from "../lib/backend.mjs";

export default async function handler(req, res) {
  await handleAssemblyNewsRequest(req, res);
}
