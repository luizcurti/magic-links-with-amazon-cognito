import { usePathname } from "./router";
import { CallbackPage } from "./pages/CallbackPage";
import { LoginPage } from "./pages/LoginPage";
import { ProfilePage } from "./pages/ProfilePage";

export function App() {
  const pathname = usePathname();

  return (
    <main className="shell">
      <div className="card">
        {pathname === "/auth/callback" ? <CallbackPage /> : pathname === "/profile" ? <ProfilePage /> : <LoginPage />}
      </div>
      <footer>Passwordless auth · Cognito CUSTOM_AUTH · LocalStack</footer>
    </main>
  );
}
