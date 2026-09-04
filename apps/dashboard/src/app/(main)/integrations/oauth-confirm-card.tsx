"use client";

import { Logo } from "@/components/logo";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import { AdminProject } from "@hexclave/next";
import { Button, Card, CardContent, CardFooter, CardHeader, Input, Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue, Typography } from "@/components/ui";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import NeonLogo from "../../../../public/neon.webp";

export default function ConfirmCard(props: {
  onContinue: (options: { projectId: string, projectName?: string }) => Promise<{ error: string } | undefined>,
  type: "neon" | "custom",
}) {
  const user = useDashboardInternalUser();
  const projects = user.useOwnedProjects();
  const searchParams = useSearchParams();

  const [selectedProject, setSelectedProject] = useState<AdminProject | null>(
    projects.find((project) => project.id === searchParams.get("default_selected_project_id"))
    ?? [...projects].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
    ?? null
  );

  return (
    <Card className="max-w-lg text-center">
      <CardHeader className="flex-row items-end justify-center gap-4">
        {props.type === "neon" && (<>
          <Image src={NeonLogo} alt="Neon" width={55} />
          <div className="relative self-center w-10 hidden dark:block">
            <div style={{
              position: "absolute",
              width: 40,
              height: 6,
              backgroundImage: "repeating-linear-gradient(135deg, #ccc, #ccc)",
              transform: "rotate(-45deg)",
            }} />
            <div style={{
              position: "absolute",
              width: 40,
              height: 6,
              backgroundImage: "repeating-linear-gradient(45deg, #ccc, #ccc)",
              transform: "rotate(45deg)",
            }} />
          </div>
          <div className="relative self-center w-10 block dark:hidden">
            <div style={{
              position: "absolute",
              width: 40,
              height: 6,
              backgroundImage: "repeating-linear-gradient(135deg, #52525B, #52525B)",
              transform: "rotate(-45deg)",
            }} />
            <div style={{
              position: "absolute",
              width: 40,
              height: 6,
              backgroundImage: "repeating-linear-gradient(45deg, #52525B, #52525B)",
              transform: "rotate(45deg)",
            }} />
          </div>
        </>)}
        <Logo noLink alt="Stack" width={50} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Typography>
          You are about to connect your {props.type === "neon" ? "Neon" : "third party"} project with Hexclave.
        </Typography>
        <Typography className="mb-3">
          Which projects would you like to connect?
        </Typography>
        <Input
          type="text"
          disabled
          prefixItem={props.type === "neon" ? <Image src={NeonLogo} alt="Neon" width={15} /> : undefined}
          value={searchParams.get("neon_project_name") || searchParams.get("external_project_name") || "Project connected!"}
        />
        <div className="flex flex-row items-center">
          <div className={'flex self-stretch justify-center items-center text-muted-foreground pl-3 select-none bg-muted/70 pr-3 border-r border-input rounded-l-md'}>
            <Logo noLink width={15} height={15} />
          </div>
          <Select
            value={selectedProject?.id ?? ""}
            onValueChange={(p) => {
              if (p === "create-new") {
                const createSearchParams = new URLSearchParams();
                createSearchParams.set(props.type === "neon" ? "redirect_to_neon_confirm_with" : "redirect_to_confirm_with", searchParams.toString());
                const projectName = searchParams.get("neon_project_name") || searchParams.get("external_project_name");
                if (projectName) {
                  createSearchParams.set("display_name", projectName);
                }
                window.location.href = '/new-project?' + createSearchParams.toString();
              } else {
                setSelectedProject(projects.find((project) => project.id === p) ?? null);
              }
            }}>
            <SelectTrigger style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "none", }}>
              <SelectValue placeholder="Select Project">
                {selectedProject && (
                  <>
                    {selectedProject.displayName} <span className="text-xs text-muted-foreground">{(selectedProject.id)}</span>
                  </>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.displayName} <span className="text-xs text-muted-foreground">{(project.id)}</span>
                  </SelectItem>
                ))}
                <SelectItem value="create-new">
                  Create new Stack project...
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <Typography className="text-sm text-muted-foreground mt-3">
          This will create an API key that gives {props.type === "neon" ? "Neon" : "the third party"} full read and write access to all resources and data in the selected Stack project, including users, roles, and permissions. You can always revoke access in the API Keys section of the Hexclave dashboard.
        </Typography>

      </CardContent>
      <CardFooter className="flex justify-end mt-4">
        <div className="flex gap-2 justify-center">
          <Button variant="secondary" onClick={() => { window.close(); }}>
            Cancel
          </Button>
          <Button
            disabled={!selectedProject}
            onClick={async () => {
              const error = await props.onContinue({ projectId: selectedProject!.id, projectName: searchParams.get("neon_project_name") ?? searchParams.get("external_project_name") ?? undefined });
              if (error) {
                throw new Error(error.error);
              }
              await new Promise((resolve) => setTimeout(resolve, 3000));
            }}>
            Connect
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
