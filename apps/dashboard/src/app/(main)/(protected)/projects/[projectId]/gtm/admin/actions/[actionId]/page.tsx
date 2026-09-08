import Loading from "@/app/loading";
import { Suspense } from "react";
import PageClient from "./page-client";

export const metadata = { title: "Growth action · Admin" };
export const instant = false;

export default function Page() {
  return <Suspense fallback={<Loading />}><PageClient /></Suspense>;
}
