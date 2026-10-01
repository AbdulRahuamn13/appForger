import { Layout } from "@/components/Layout.tsx";
import { Toaster } from "@/components/ui/toast.tsx";
import { useAttentionNotifications } from "@/lib/notify.ts";
import { useRoute } from "@/lib/router.ts";
import { useTheme } from "@/lib/theme.ts";
import { HomePage } from "@/pages/HomePage.tsx";
import { ProjectPage } from "@/pages/ProjectPage.tsx";
import { RunPage } from "@/pages/RunPage.tsx";
import { SettingsPage } from "@/pages/SettingsPage.tsx";
import { SkillsPage } from "@/pages/SkillsPage.tsx";

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  useAttentionNotifications();
  return (
    <>
      <Layout route={route} theme={theme} setTheme={setTheme}>
        {route.page === "home" && <HomePage />}
        {route.page === "project" && <ProjectPage key={route.id} id={route.id} tab={route.tab} item={route.item} />}
        {route.page === "run" && <RunPage key={route.id} id={route.id} />}
        {route.page === "skills" && <SkillsPage />}
        {route.page === "settings" && <SettingsPage section={route.section} theme={theme} setTheme={setTheme} />}
      </Layout>
      <Toaster />
    </>
  );
}
