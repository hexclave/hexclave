import { Button } from "@hexclave/ui";
import { useStackApp } from "../../..";
import { useUser } from "../../../lib/hooks";
import { useTranslation } from "../../../lib/translations";
import { Section } from "../section";

export function SignOutSection(props?: { mockMode?: boolean }) {
  const { t } = useTranslation();
  const app = useStackApp();
  // External-auth apps render nothing here, and the provider can clear its session (so Hexclave has no user)
  // before this re-renders, so don't throw for them.
  const user = useUser({ or: props?.mockMode || app.isExternalAuthApp() ? "return-null" : "throw" });

  if (app.isExternalAuthApp()) {
    return null;
  }

  const handleSignOut = async () => {
    if (props?.mockMode) {
      // Mock mode - just show an alert or do nothing
      alert("Mock mode: Sign out clicked");
      return;
    }
    if (user) {
      await user.signOut();
    }
  };

  return (
    <Section
      title={t("Sign out")}
      description={t("End your current session")}
    >
      <div>
        <Button
          variant='secondary'
          onClick={handleSignOut}
        >
          {t("Sign out")}
        </Button>
      </div>
    </Section>
  );
}
