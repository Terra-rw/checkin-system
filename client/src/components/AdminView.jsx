// Screens for managers and HR admins. Which tabs exist is decided in App.jsx by role.
import { useState } from 'react';
import Attendance from './admin/Attendance.jsx';
import Employees from './admin/Employees.jsx';
import Reports from './admin/Reports.jsx';
import Settings from './admin/Settings.jsx';
import Security from './admin/Security.jsx';
import Branding from './admin/Branding.jsx';
import { Holidays, Roles } from './admin/Holidays.jsx';
import { TeamTimeOff } from './TimeOff.jsx';

export default function AdminView({ me, tab, onBrandingSaved, refresh }) {
  const [settingsTab, setSettingsTab] = useState('general');
  if (tab === 'reports') return <Reports me={me} />;
  if (tab === 'timeoff') return <TeamTimeOff me={me} onChange={refresh} />;
  if (tab === 'employees') return <Employees me={me} />;
  if (tab === 'settings') {
    return (
      <div className="stack">
        <nav className="subtabs wrap" aria-label="Settings sections">
          {[
            ['general', 'Office, hours & alerts'],
            ['holidays', 'Holidays & closures'],
            ['roles', 'Roles & permissions'],
            ['branding', 'Branding'],
            ['security', 'Security & devices'],
          ].map(([key, label]) => (
            <button key={key} className={settingsTab === key ? 'active' : ''} aria-current={settingsTab === key ? 'page' : undefined} onClick={() => setSettingsTab(key)}>
              {label}
            </button>
          ))}
        </nav>
        {settingsTab === 'general' && <Settings />}
        {settingsTab === 'holidays' && <Holidays me={me} />}
        {settingsTab === 'roles' && <Roles />}
        {settingsTab === 'branding' && <Branding me={me} onSaved={onBrandingSaved} />}
        {settingsTab === 'security' && <Security me={me} />}
      </div>
    );
  }
  return <Attendance me={me} />;
}
