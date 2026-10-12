import { withAuth } from "@workos-inc/authkit-nextjs";
import { WorkosDemo } from "./workos-demo";

export default async function Page() {
  const { user, sessionId, accessToken } = await withAuth();

  if (user == null || accessToken == null || sessionId == null) {
    return <main><p className="eyebrow">External authentication demo</p><h1>WorkOS AuthKit <span>→</span> Hexclave</h1><p className="lede">Sign in through hosted WorkOS AuthKit to exchange a genuine provider token for a Hexclave session.</p><a href="/auth/sign-in">Sign in with WorkOS AuthKit</a></main>;
  }
  return <WorkosDemo />;
}
