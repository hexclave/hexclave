import { signOut } from "@workos-inc/authkit-nextjs";

async function handleSignOut() {
  await signOut();
}

export const GET = handleSignOut;
export const POST = handleSignOut;
