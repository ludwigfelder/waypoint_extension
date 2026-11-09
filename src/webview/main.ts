import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

// The Waypoint "Plan Review" UI is self-themed, independent of the VS Code
// theme: the chrome is always dark (root tokens in app.css), and the theme
// toggle only re-themes the plan card ([data-plan-theme], stamped by the
// document components) plus the matching highlight.js stylesheet.
mount(App, { target: document.getElementById("app")! });
