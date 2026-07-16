import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import OptionsPositionAnalyzer from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <OptionsPositionAnalyzer />
  </StrictMode>
);
