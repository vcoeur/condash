// Augments Solid's JSX namespace with the Electron `<webview>` element.
import 'solid-js';

declare module 'solid-js' {
  namespace JSX {
    interface IntrinsicElements {
      webview: JSX.HTMLAttributes<HTMLElement> & {
        src?: string;
        partition?: string;
        nodeintegration?: boolean | string;
        disablewebsecurity?: boolean | string;
        allowpopups?: boolean | string;
        webpreferences?: string;
      };
    }
  }
}
