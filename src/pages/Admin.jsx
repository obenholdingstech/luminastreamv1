import { useState } from 'react';
import AdminGate from '@/components/admin/AdminGate';
import AdminDashboard from '@/components/admin/AdminDashboard';

export default function Admin() {
  const [authenticated, setAuthenticated] = useState(false);
  const [passcode, setPasscode] = useState('');

  if (!authenticated) {
    return <AdminGate onSuccess={(pw) => { setPasscode(pw); setAuthenticated(true); }} />;
  }

  return (
    <AdminDashboard
      passcode={passcode}
      onLogout={() => {
        setAuthenticated(false);
        setPasscode('');
      }}
    />
  );
}