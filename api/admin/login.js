import { handleAdminLogin, withApiErrorHandling } from "../../lib/backend.mjs";

export default withApiErrorHandling(handleAdminLogin, "Unexpected error while signing in.");
