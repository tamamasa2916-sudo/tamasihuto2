import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ShiftPlanner from "./ShiftPlanner.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ShiftPlanner />
  </StrictMode>
);
