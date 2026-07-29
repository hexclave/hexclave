export default function Layout(props: { children: React.ReactNode }) {
  // Old /project-settings/* routes redirect into Project Settings; keep a passthrough
  // layout so we don't flash the retired Environment chrome.
  return props.children;
}
