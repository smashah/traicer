import React from "react";
import { createRoot } from "react-dom/client";

const App = () => (
  <main style={{ fontFamily: "system-ui", padding: 24 }}>
    <p style={{ fontFamily: "monospace", textTransform: "uppercase" }}>Traicer · Milestone 0</p>
    <h1>Capture is not configured</h1>
    <p>The executable spike exposes local control only. Provider capture, storage, and marketplace egress remain disabled.</p>
  </main>
);

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
