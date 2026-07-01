import { handleAdminSession, withApiErrorHandling } from "../../lib/backend.mjs";

export default withApiErrorHandling(handleAdminSession, "Unexpected error while checking the admin session.");
