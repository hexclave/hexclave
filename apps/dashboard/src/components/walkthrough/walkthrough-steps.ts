export type WalkthroughPhase = 'navigating' | 'dwelling' | 'finishing';

export type WalkthroughStep = {
  id: string,
  path: string,
  cmdkSearch?: string,
  sidebarNavLabel?: string,
  title: string,
  description: string,
  spotlightPadding?: number,
};

export type SpotlightRect = {
  top: number,
  left: number,
  width: number,
  height: number,
};

export const WALKTHROUGH_STEPS: WalkthroughStep[] = [
  {
    id: 'overview-globe',
    path: '/',
    sidebarNavLabel: 'Overview',
    title: 'Global User Map',
    description: 'Pinch-zoom around the globe and see where sign-ups are landing.',
    spotlightPadding: 12,
  },
  {
    id: 'overview-metrics',
    path: '/',
    title: 'Usage Metrics',
    description: 'Daily actives, sign-ups, and retention — the numbers you actually check.',
    spotlightPadding: 12,
  },
  {
    id: 'users-table',
    path: '/users',
    cmdkSearch: 'Users',
    title: 'User Management',
    description: 'Search, export, impersonate, or spin up test users in one place.',
  },
  {
    id: 'teams-table',
    path: '/teams',
    cmdkSearch: 'Teams',
    title: 'Teams',
    description: 'Multi-tenant apps live here. Teams, roles, invites — the whole stack.',
  },
  {
    id: 'emails-sent',
    path: '/email-sent',
    cmdkSearch: 'Emails sent',
    title: 'Email Logs',
    description: 'Every sent email, delivery status, and domain health in one feed.',
  },
  {
    id: 'payments-products',
    path: '/app-configuration/payments/products',
    cmdkSearch: 'Products',
    title: 'Products & Pricing',
    description: 'Products, prices, and subscriptions wired straight to Stripe.',
  },
  {
    id: 'analytics-replays',
    path: '/session-replays',
    sidebarNavLabel: 'Replays',
    title: 'Session Replays',
    description: 'Watch real sessions — clicks, rage taps, and dead ends included.',
  },
];
