'use client';

import { CodeBlock, codePanelShellClasses } from '@/components/code-block';
import { DesignButton } from "@/components/design-components";
import { EnvFileViewer } from '@/components/env-keys';
import { InlineCode } from '@/components/inline-code';
import { Tabs, TabsList, TabsTrigger, Typography, cn } from "@/components/ui";
import { getPublicEnvVar } from '@/lib/env';
import {
  buildCliDevSetupPrompt,
  buildOnboardingConfigFile,
  getManualSetupDocsUrl,
  getSetupDocsBaseUrl,
  prependConfigChangesToSetupPrompt,
} from '@/lib/setup-prompt';
import { useThemeWatcher } from '@/lib/theme';
import { BookIcon, XIcon } from "@phosphor-icons/react";
import { use } from "@hexclave/shared/dist/utils/react";
import dynamic from "next/dynamic";
import { Suspense, useRef, useState } from "react";
import type { GlobeMethods } from 'react-globe.gl';
import { PageLayout } from "../page-layout";
import { useAdminApp } from '../use-admin-app';
import { globeImages } from './globe';
import styles from './setup-page.module.css';

const countriesPromise = import('./country-data.geo.json');
const Globe = dynamic(() => import('react-globe.gl').then((mod) => mod.default), { ssr: false });

type SetupMode = "recommended" | "manual";

export default function SetupPage(props: { toMetrics: () => void }) {
  const adminApp = useAdminApp();
  const [setupMode, setSetupMode] = useState<SetupMode>("recommended");
  const [keys, setKeys] = useState<{ projectId: string, publishableClientKey?: string, secretServerKey: string } | null>(null);
  const projectConfig = adminApp.useProject().useConfig();
  const requirePublishableClientKey = projectConfig.project.requirePublishableClientKey;
  const isRemoteDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";

  const onGenerateKeys = async () => {
    const newKey = await adminApp.createInternalApiKey({
      hasPublishableClientKey: requirePublishableClientKey,
      hasSecretServerKey: true,
      hasSuperSecretAdminKey: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 200),
      description: 'Onboarding',
    });

    setKeys({
      projectId: adminApp.projectId,
      publishableClientKey: newKey.publishableClientKey ?? undefined,
      secretServerKey: newKey.secretServerKey!,
    });
  };

  const setupDocsBaseUrl = getSetupDocsBaseUrl();
  const onboardingConfigFile = buildOnboardingConfigFile(projectConfig);
  const selectedInstallPrompt = prependConfigChangesToSetupPrompt(
    buildCliDevSetupPrompt({
      docsBaseUrl: setupDocsBaseUrl,
    }),
    onboardingConfigFile,
  );
  const manualSetupDocsUrl = getManualSetupDocsUrl();

  return (
    <PageLayout width={1000}>
      <div className="flex justify-end">
        <DesignButton variant='plain' onClick={props.toMetrics}>
          Close Setup
          <XIcon className="w-4 h-4 ml-1 mt-0.5" />
        </DesignButton>
      </div>
      <div className="flex gap-4 justify-center items-center rounded-2xl py-4 px-8 backdrop-blur-md bg-white/60 dark:bg-background/40 ring-1 ring-black/[0.06] dark:ring-white/[0.06] border border-black/[0.06] dark:border-white/[0.06] shadow-sm">
        <GlobeIllustration />

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div className='text-[rgb(107,93,247)] flex items-center gap-1.5 text-xs font-bold'>
              <div className={styles.livePulse} />
              Waiting for your first user...
            </div>
            <Typography type="h2">
              Setup Hexclave in your codebase
            </Typography>
            <Typography variant="secondary" className="max-w-xl text-sm leading-relaxed">
              {isRemoteDevelopmentEnvironment
                ? "You're using the local dashboard on your computer for development. Production uses a separate Hexclave Cloud project."
                : "You're viewing your production Hexclave Cloud project. The local dashboard runs on your computer during development."}
            </Typography>
          </div>

          <Typography>
            <DesignButton
              variant='outline'
              size='sm'
              onClick={() => {
                window.open(setupDocsBaseUrl, '_blank');
              }}
            >
              <BookIcon className="w-4 h-4 mr-2" />
              Full Documentation
            </DesignButton>
          </Typography>
          {isRemoteDevelopmentEnvironment && (
            <Typography variant="secondary" className="max-w-xl">
              For local config projects, run your app with <InlineCode>hexclave dev</InlineCode>. It injects the project ID and secret key automatically, so you do not need to create project keys or write Hexclave environment variables.
            </Typography>
          )}
        </div>
      </div>

      {isRemoteDevelopmentEnvironment ? (
        <>
          <div className="mx-4 mt-8 flex justify-end">
            <Tabs value={setupMode} onValueChange={(value) => setSetupMode(value === "manual" ? "manual" : "recommended")}>
              <TabsList>
                <TabsTrigger value="recommended">AI Prompt (recommended)</TabsTrigger>
                <TabsTrigger value="manual">Manual setup</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {setupMode === "recommended" ? (
            <div className="mx-4 mt-4 flex flex-col">
              <ol className="relative border-s border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {[
                  {
                    step: 1,
                    title: "Copy Setup Prompt",
                    content: (
                      <div className="flex min-w-0 flex-col gap-4">
                        <CodeBlock
                          language="text"
                          content={selectedInstallPrompt}
                          customRender={
                            <pre className="max-h-[480px] overflow-y-auto whitespace-pre-wrap break-words p-4 text-sm leading-6 text-foreground">
                              {selectedInstallPrompt}
                            </pre>
                          }
                          title="Prompt for your AI agent"
                          icon="code"
                          maxHeight={480}
                        />
                      </div>
                    ),
                  },
                  {
                    step: 2,
                    title: "Done",
                    content: <SetupRecommendedDoneStep onExploreDashboard={props.toMetrics} />,
                  },
                ].map((item) => (
                  <li key={item.step} className={cn("ms-6 mb-20 flex flex-col gap-10 lg:flex-row")}>
                    <div className="flex min-w-[180px] max-w-[180px] flex-col justify-center gap-2">
                      <span className="absolute -start-4 flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 ring-4 ring-white dark:bg-zinc-800 dark:ring-zinc-900">
                        <span className="font-semibold text-zinc-500 dark:text-zinc-400">{item.step}</span>
                      </span>
                      <h3 className="font-medium leading-tight">{item.title}</h3>
                    </div>
                    <div className="flex min-w-0 flex-grow flex-col gap-4">
                      {item.content}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="mx-4 mt-8 space-y-8">
              <div className="grid gap-4 sm:grid-cols-[2rem_minmax(0,1fr)]">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground/[0.06] text-sm font-semibold">1</div>
                <div className="space-y-3">
                  <Typography type="h2">Follow the manual setup steps in the documentation</Typography>
                  <Typography variant="secondary">
                    The documentation stays current for every framework and SDK.
                  </Typography>
                  <DesignButton
                    variant="outline"
                    onClick={() => {
                      window.open(manualSetupDocsUrl, '_blank');
                    }}
                  >
                    <BookIcon className="mr-2 h-4 w-4" />
                    Open manual setup docs
                  </DesignButton>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-[2rem_minmax(0,1fr)]">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground/[0.06] text-sm font-semibold">2</div>
                <div className="min-w-0 space-y-3">
                  <Typography type="h2">Copy-paste this config file</Typography>
                  <CodeBlock
                    language="typescript"
                    content={onboardingConfigFile}
                    title="hexclave.config.ts"
                    icon="code"
                    maxHeight={480}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="mx-4 mt-12 flex flex-col items-center gap-4 py-16 text-center">
          <Typography type="h2">Waiting for your first user...</Typography>
          <HexclaveKeys keys={keys} onGenerateKeys={onGenerateKeys} />
        </div>
      )}
    </PageLayout>
  );
}

function GlobeIllustration() {
  return (
    <div className="w-[200px] h-[200px] relative hidden md:block">
      <Suspense fallback={"LOADING"}>
        <GlobeIllustrationInner />
      </Suspense>
    </div>
  );
}

function GlobeIllustrationInner() {
  const { theme, mounted } = useThemeWatcher();
  const [showPulse, setShowPulse] = useState(false);
  const globeEl = useRef<GlobeMethods | undefined>(undefined);
  const countries = use(countriesPromise);

  return (
    <>
      {showPulse && (
        <div className="absolute inset-0 pointer-events-none w-[200px] h-[200px] flex items-center justify-center">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className={`${styles['pulse-circle']} rounded-full bg-blue-200 dark:bg-blue-800`}
              style={{
                width: "50px",
                height: "50px",
                animationDelay: `${i * 2.5}s`,
              }}
            />
          ))}
        </div>
      )}

      <div className="relative z-10 items-center justify-center w-full h-full hidden md:flex">
        {mounted && (
          <Globe
            ref={globeEl}
            onGlobeReady={() => {
              const setupControls = () => {
                if (globeEl.current) {
                  const controls = globeEl.current.controls();
                  controls.autoRotate = true;
                  controls.enableZoom = false;
                  controls.enablePan = false;
                  controls.enableRotate = false;
                  return true;
                }
                return false;
              };

              setupControls();
              // Sometimes the controls don't get set up in time, so we try again
              setTimeout(setupControls, 100);
              setTimeout(() => setShowPulse(true), 200);
            }}
            globeImageUrl={globeImages[theme]}
            backgroundColor="#00000000"
            polygonsData={countries.features}
            polygonCapColor={() => "transparent"}
            polygonSideColor={() => "transparent"}
            hexPolygonsData={countries.features}
            hexPolygonResolution={1}
            hexPolygonMargin={0.2}
            hexPolygonAltitude={0.003}
            hexPolygonColor={() => "rgb(107, 93, 247)"}
            width={160}
            height={160}
          />
        )}
      </div>
    </>
  );
}

function SetupRecommendedDoneStep(props: { onExploreDashboard: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Typography>
        Hooray! Setup completed.
      </Typography>
      <div>
        <DesignButton onClick={props.onExploreDashboard}>
          Explore Dashboard
        </DesignButton>
      </div>
    </div>
  );
}

function HexclaveKeys(props: {
  keys: { projectId: string, publishableClientKey?: string, secretServerKey: string } | null,
  onGenerateKeys: () => Promise<void>,
}) {
  if (!props.keys) {
    return (
      <div className={cn(codePanelShellClasses, "w-full p-5 flex flex-col")}>
        <div className="flex items-center justify-center">
          <DesignButton onClick={props.onGenerateKeys}>
            Generate Project Keys
          </DesignButton>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-3">
      <EnvFileViewer
        filename=".env.local"
        value={`NEXT_PUBLIC_HEXCLAVE_PROJECT_ID=${props.keys.projectId}\nHEXCLAVE_SECRET_SERVER_KEY=${props.keys.secretServerKey}`}
      />

      <Typography type="label" variant="secondary">
        {`Save these keys securely - they won't be shown again after leaving this page.`}
      </Typography>
    </div>
  );
}
