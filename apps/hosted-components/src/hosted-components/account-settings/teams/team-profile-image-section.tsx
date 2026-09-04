
import { Team, useUser } from "@hexclave/react";
import { ProfileImageEditor } from "../profile-image-editor";
import { Section } from "../section";

export function TeamProfileImageSection(props: { team: Team }) {
  const user = useUser({ or: 'redirect' });
  const updateTeamPermission = user.usePermission(props.team, '$update_team');

  if (!updateTeamPermission) {
    return null;
  }

  return (
    <Section
      title="Team profile image"
      description="Upload an image for your team"
    >
      <ProfileImageEditor
        user={props.team}
        onProfileImageUrlChange={async (profileImageUrl) => {
          await props.team.update({ profileImageUrl });
        }}
      />
    </Section>
  );
}
