import { handleAssemblyNewsRequest, withApiErrorHandling } from "../lib/backend.mjs";

export default withApiErrorHandling(
  handleAssemblyNewsRequest,
  "Unexpected error while loading assembly coverage.",
);
