
import { useUser } from "@hexclave/react";
import { ProfileImageEditor } from "../profile-image-editor";
import { EditableText } from "../editable-text";
import { PageLayout } from "../page-layout";
import { Section } from "../section";

export function ProfilePage(props?: {
  mockUser?: {
    displayName?: string,
    profileImageUrl?: string,
  },
}) {
  const userFromHook = useUser({ or: props?.mockUser ? 'return-null' : 'redirect' });

  // Use mock data if provided, otherwise use real user
  const user = props?.mockUser ? {
    displayName: props.mockUser.displayName || 'John Doe',
    profileImageUrl: props.mockUser.profileImageUrl || null,
    update: async (updates: any) => {
      console.log('Mock update called with:', updates);
    }
  } : userFromHook;

  if (!user) {
    return null; // This shouldn't happen in practice
  }

  return (
    <PageLayout>
      <Section
        title="User name"
        description="This is a display name and is not used for authentication"
      >
        <EditableText
          value={user.displayName || ''}
          onSave={async (newDisplayName) => {
            await user.update({ displayName: newDisplayName });
          }}
        />
      </Section>

      <Section
        title="Profile image"
        description="Upload your own image as your avatar"
      >
        <ProfileImageEditor
          user={user}
          onProfileImageUrlChange={async (profileImageUrl: string | null) => {
            await user.update({ profileImageUrl });
          }}
        />
      </Section>
    </PageLayout>
  );
}
