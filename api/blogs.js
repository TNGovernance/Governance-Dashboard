import { handleBlogsRequest, withApiErrorHandling } from "../lib/backend.mjs";

export default withApiErrorHandling(handleBlogsRequest, "Unexpected error while loading blog updates.");
