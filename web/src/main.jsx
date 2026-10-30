// The app's entry point. App comes before the shared stylesheets on purpose: the stylesheets its pages import are
// then bundled ahead of these, so the shared rules win where the two set the same thing with the same weight.
import * as ReactDOM from "react-dom/client";
import App from "./App.jsx"; // (first, as said above)
import "./theme.css"; // the tokens, light and dark, and the base rules
import "./app.css"; // the shell and the parts every page shares
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
