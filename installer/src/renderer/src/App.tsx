import { useState } from "react";
import Welcome from "./screens/Welcome";
import PrereqCheck from "./screens/PrereqCheck";
import InstallComplete from "./screens/InstallComplete";

type ScreenId = "welcome" | "prereq-check" | "install-complete";

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<ScreenId>("welcome");

  if (screen === "install-complete") {
    return <InstallComplete />;
  }

  if (screen === "prereq-check") {
    return <PrereqCheck onInstallComplete={() => setScreen("install-complete")} />;
  }

  return <Welcome onGetStarted={() => setScreen("prereq-check")} />;
}
