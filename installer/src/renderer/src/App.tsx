import { useState } from "react";
import Welcome from "./screens/Welcome";
import PrereqCheck from "./screens/PrereqCheck";

type ScreenId = "welcome" | "prereq-check";

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<ScreenId>("welcome");

  if (screen === "prereq-check") {
    return <PrereqCheck />;
  }

  return <Welcome onGetStarted={() => setScreen("prereq-check")} />;
}
