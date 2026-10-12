"use client";

import { HexclaveHandler } from "@hexclave/next";
import { useEffect, useState } from "react";

export default function Handler() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <HexclaveHandler fullPage />;
}
