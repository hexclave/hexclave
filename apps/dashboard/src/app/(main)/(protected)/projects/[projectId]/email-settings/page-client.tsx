"use client";

// Old /email-settings page now redirects to Project Settings → Email.
// Keep this module as DomainSettings-only so accidental imports cannot revive the
// mixed themes + delivery surface.
export { default } from "../project-settings/email/page-client";
