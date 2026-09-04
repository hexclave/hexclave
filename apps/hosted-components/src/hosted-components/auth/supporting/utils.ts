import { useEffect, useState } from "react";

type SearchParams = Partial<Record<string, string>>;

export function getSearchParams(): SearchParams {
  if (typeof window === "undefined") {
    return {};
  }

  const params: SearchParams = {};
  new URLSearchParams(window.location.search).forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

export function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function useInIframe() {
  const [inIframe, setInIframe] = useState(false);

  useEffect(() => {
    setInIframe(window.self !== window.top);
  }, []);

  return inIframe;
}
