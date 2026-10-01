import { Layout } from "@/components/Layout.tsx";
import { useRoute } from "@/lib/router.ts";
import { ProjectPage } from "@/pages/ProjectPage.tsx";
import { ProjectsPage } from "@/pages/ProjectsPage.tsx";
import { ProvidersPage } from "@/pages/ProvidersPage.tsx";
import { RunPage } from "@/pages/RunPage.tsx";

export function App() {
  const route = useRoute();
  return (
    <Layout route={route}>
      {route.page === "projects" && <ProjectsPage />}
      {route.page === "project" && <ProjectPage key={route.id} id={route.id} />}
      {route.page === "providers" && <ProvidersPage />}
      {route.page === "run" && <RunPage key={route.id} id={route.id} />}
    </Layout>
  );
}
