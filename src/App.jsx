import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';

import ScrollToTop from './components/ScrollToTop';
import Account from './pages/Account';
import Admin from './pages/Admin';
import Landing from './pages/Landing';
import LiveKitTest from './pages/LiveKitTest';
import PageNotFound from './pages/PageNotFound';
import Studio from './pages/Studio';
import { surfaceForHost } from './lib/surface';

// One deploy, three surfaces, routed by HOSTNAME (the realignment, CEO
// 7 Aug 2026):
//
//   luminastream.live            the public hero — the only page a stranger
//                                should ever meet
//   account.luminastream.live    sign-in / sign-up / verification
//   studio.luminastream.live     the workspace, signed-in only (the studio
//                                itself bounces the signed-out to account)
//
// Previews and localhost resolve to the studio surface, because dev and the
// probes live there. The console stays a route on the working surface.
//
// There is no auth provider wrapping this tree. Session authority lives
// server-side (an HttpOnly cookie the Worker resolves); pages that care ask
// via useAuth.
function App() {
  const surface = surfaceForHost(globalThis.location?.hostname);

  if (surface === 'landing') return <Landing />;
  if (surface === 'account') return <Account />;
  if (surface === 'admin') return <Admin />;

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
