import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { OrgProvider } from '@/contexts/OrgContext';
import { Layout } from '@/components/Layout';
import { LoginPage } from '@/pages/Login';
import { SignupPage } from '@/pages/Signup';
import { DashboardPage } from '@/pages/Dashboard';
import { BillsPage } from '@/pages/Bills';
import { BillDetailPage } from '@/pages/BillDetail';
import { AllocationsPage } from '@/pages/Allocations';
import { JobsPage } from '@/pages/Jobs';
import { CustomersPage } from '@/pages/Customers';
import { SuppliersPage } from '@/pages/Suppliers';
import { EmployeesPage } from '@/pages/Employees';
import { SettingsPage } from '@/pages/Settings';

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
            <Route path="bills/:id" element={<BillDetailPage />} />
            <Route path="allocations" element={<AllocationsPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="employees" element={<EmployeesPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </OrgProvider>
    </AuthProvider>
  );
}
