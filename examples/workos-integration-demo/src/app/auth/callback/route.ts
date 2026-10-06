import { handleAuth } from "@workos-inc/authkit-nextjs";
import { NextRequest } from "next/server";
import { getWorkOSBaseUrl } from "../../../lib/workos";

export async function GET(request: NextRequest) {
  return await handleAuth({
    baseURL: getWorkOSBaseUrl(),
  })(request);
}
