import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';

import ScrollToTop from './components/ScrollToTop';
import PageNotFound from './lib/PageNotFound';
import LiveKitTest from './pages/LiveKitTest';
import Studio from './pages/Studio';

// Two surfaces, one engine.
//
//   /              the lens — what the product is
//   /livekit-test  the console — the instrument the lens is tuned with
//
// Both drive the same agent through the same hook. The console is not a
// staging area for the product; it is permanently valuable and permanently
// dev-only, which is why it keeps its own route rather than hiding behind a
// flag on this one.
//
// There is no auth provider here any more. The one that used to wrap this tree
// authenticated against a backend that no longer exists — it resolved to a
// fail-soft error on every load and gated nothing. Session authority now lives
// server-side in workers/api.
function App() {
  return (
    <Router>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Studio />} />
        <Route path="/livekit-test" element={<LiveKitTest />} />
        <Route path="*" element={<PageNotFound />} />
      </Routes>
    </Router>
  );
}

export default App;
