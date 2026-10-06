import * as ReactDOM from "react-dom";
import * as Client from "react-dom/client";
(window as any).ReactDOM = { ...ReactDOM, ...Client };
