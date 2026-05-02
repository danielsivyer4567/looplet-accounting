import { Routes, Route, Navigate, Link } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { OrgProvider } from '@/contexts/OrgContext';
import { Layout } from '@/components/Layout';
import { LoginPage } from '@/pages/Login';
import { SignupPage } from '@/pages/Signup';
import { DashboardPage } from '@/pages/Dashboard';
import { BillsPage } from '@/pages/Bills';
import { BillUploadPage } from '@/pages/BillUpload';
import { BillDetailPage } from '@/pages/BillDetail';
import { AllocationsPage } from '@/pages/Allocations';
import { ReconciliationPage } from '@/pages/Reconciliation';
import { JobsPage } from '@/pages/Jobs';
import { JobDetailPage } from '@/pages/JobDetail';
import { CustomersPage } from '@/pages/Customers';
import { SuppliersPage } from '@/pages/Suppliers';
import { SupplierDetailPage } from '@/pages/SupplierDetail';
import { EmployeesPage } from '@/pages/Employees';
import { SettingsPage } from '@/pages/Settings';
import { GmailCallbackPage } from '@/pages/GmailCallback';
import { BankCallbackPage } from '@/pages/BankCallback';
import { AutoSetupPage } from '@/pages/onboarding/AutoSetup';
import { TriagePage } from '@/pages/onboarding/Triage';

function PlaceholderPage({ title, back }: { title: string; back: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <p style={{ color: '#888' }}>Detail view coming in a future phase.</p>
      <Link to={back} style={{ color: '#86c7a3', fontSize: 13 }}>
        &larr; Back
      </Link>
    </section>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ padding: '2rem' }}>Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <OrgProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="bills" element={<BillsPage />} />
            <Route path="bills/upload" element={<BillUploadPage />} />
            <Route path="bills/:id" element={<BillDetailPage />} />
            <Route path="allocations" element={<AllocationsPage />} />
            <Route path="reconciliation" element={<ReconciliationPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="jobs/:id" element={<JobDetailPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="customers/:id" element={<PlaceholderPage title="Customer detail" back="/customers" />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="suppliers/:id" element={<SupplierDetailPage />} />
            <Route path="employees" element={<EmployeesPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="settings/gmail-callback" element={<GmailCallbackPage />} />
            <Route path="settings/bank-callback" element={<BankCallbackPage />} />
            <Route path="onboarding" element={<AutoSetupPage />} />
            <Route path="onboarding/triage" element={<TriagePage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </OrgProvider>
    </AuthProvider>
  );
}
