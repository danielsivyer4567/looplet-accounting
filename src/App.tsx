import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/contexts/AuthContext';
import { useAuth } from '@/hooks/useAuth';
import { OrgProvider } from '@/contexts/OrgContext';
import { useOrg } from '@/hooks/useOrg';
import { Layout } from '@/components/Layout';
import { LoginPage } from '@/pages/Login';
import { SignupPage } from '@/pages/Signup';
import { AcceptInvitePage } from '@/pages/AcceptInvite';
import { DashboardPage } from '@/pages/Dashboard';
import { BillsPage } from '@/pages/Bills';
import { BillUploadPage } from '@/pages/BillUpload';
import { BillDetailPage } from '@/pages/BillDetail';
import { AllocationsPage } from '@/pages/Allocations';
import { CodingReviewPage } from '@/pages/CodingReview';
import { ReconciliationPage } from '@/pages/Reconciliation';
import { JobsPage } from '@/pages/Jobs';
import { JobDetailPage } from '@/pages/JobDetail';
import { CustomersPage } from '@/pages/Customers';
import { CustomerDetailPage } from '@/pages/CustomerDetail';
import { InvoicesPage } from '@/pages/Invoices';
import { InvoiceDetailPage } from '@/pages/InvoiceDetail';
import { SubscriptionsPage } from '@/pages/Subscriptions';
import { SubscriptionDetailPage } from '@/pages/SubscriptionDetail';
import { DebtsPage } from '@/pages/Debts';
import { DebtDetailPage } from '@/pages/DebtDetail';
import { QualityPage } from '@/pages/Quality';
import { ReportsIndexPage } from '@/pages/reports/Index';
import { BasReportPage } from '@/pages/reports/Bas';
import { CashFlowPage } from '@/pages/reports/CashFlow';
import { BalanceSheetPage } from '@/pages/reports/BalanceSheet';
import { EofyReportPage } from '@/pages/reports/EOFY';
import { TaxReturnPage } from '@/pages/reports/TaxReturn';
import { FbtReportPage } from '@/pages/reports/Fbt';
import { TparReportPage } from '@/pages/reports/Tpar';
import { FrankingReportPage } from '@/pages/reports/Franking';
import { SgcReportPage } from '@/pages/reports/Sgc';
import { NotificationsPage } from '@/pages/Notifications';
import { SuppliersPage } from '@/pages/Suppliers';
import { SupplierDetailPage } from '@/pages/SupplierDetail';
import { TrustsPage } from '@/pages/Trusts';
import { TrustDetailPage } from '@/pages/TrustDetail';
import { SmsfPage } from '@/pages/SMSF';
import { EmployeesPage } from '@/pages/Employees';
import { EmployeeDetailPage } from '@/pages/EmployeeDetail';
import { SettingsPage } from '@/pages/Settings';
import { RegistrationsPage } from '@/pages/settings/Registrations';
import { TeamPage } from '@/pages/Team';
import { AuditLogPage } from '@/pages/AuditLog';
import { GmailCallbackPage } from '@/pages/GmailCallback';
import { BankCallbackPage } from '@/pages/BankCallback';
import { XeroCallbackPage } from '@/pages/XeroCallback';
import { AutoSetupPage } from '@/pages/onboarding/AutoSetup';
import { TriagePage } from '@/pages/onboarding/Triage';
import { PaymentRunsPage } from '@/pages/PaymentRuns';
import { ApprovalsPage } from '@/pages/Approvals';
import { LodgementsPage } from '@/pages/Lodgements';
import { NewPaymentRunPage } from '@/pages/NewPaymentRun';
import { PaymentRunDetailPage } from '@/pages/PaymentRunDetail';
import { PayrollPage } from '@/pages/Payroll';
import { PayRunDetailPage } from '@/pages/PayRunDetail';
import { AskPage } from '@/pages/Ask';
import { ScanPage } from '@/pages/Scan';
import { ReceiptHubPage } from '@/pages/ReceiptHub';
import { FixedAssetsPage } from '@/pages/FixedAssets';
import { MyActivityPage } from '@/pages/MyActivity';
import { LegalHorizonPage } from '@/pages/LegalHorizon';
import { ClientsPage } from '@/pages/Clients';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ padding: '2rem' }}>Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// Role-aware landing: accountant-only users have no books of their own, so the
// dashboard is empty for them — send them straight to their client picker.
function HomeRoute() {
  const { loading, isAccountantOnly } = useOrg();
  if (loading) return <div style={{ padding: '2rem' }}>Loading…</div>;
  if (isAccountantOnly) return <Navigate to="/clients" replace />;
  return <DashboardPage />;
}

export function App() {
  return (
    <AuthProvider>
      <OrgProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/accept-invite" element={<AcceptInvitePage />} />
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<HomeRoute />} />
            <Route path="clients" element={<ClientsPage />} />
            <Route path="bills" element={<BillsPage />} />
            <Route path="bills/upload" element={<BillUploadPage />} />
            <Route path="bills/:id" element={<BillDetailPage />} />
            <Route path="allocations" element={<AllocationsPage />} />
            <Route path="coding-review" element={<CodingReviewPage />} />
            <Route path="approvals" element={<ApprovalsPage />} />
            <Route path="lodgements" element={<LodgementsPage />} />
            <Route path="reconciliation" element={<ReconciliationPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="jobs/:id" element={<JobDetailPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="customers/:id" element={<CustomerDetailPage />} />
            <Route path="invoices" element={<InvoicesPage />} />
            <Route path="invoices/new" element={<InvoiceDetailPage />} />
            <Route path="invoices/:id" element={<InvoiceDetailPage />} />
            <Route path="subscriptions" element={<SubscriptionsPage />} />
            <Route path="subscriptions/:id" element={<SubscriptionDetailPage />} />
            <Route path="debts" element={<DebtsPage />} />
            <Route path="debts/:id" element={<DebtDetailPage />} />
            <Route path="quality" element={<QualityPage />} />
            <Route path="reports" element={<ReportsIndexPage />} />
            <Route path="reports/bas" element={<BasReportPage />} />
            <Route path="reports/cash-flow" element={<CashFlowPage />} />
            <Route path="reports/balance-sheet" element={<BalanceSheetPage />} />
            <Route path="reports/eofy" element={<EofyReportPage />} />
            <Route path="reports/tax-return" element={<TaxReturnPage />} />
            <Route path="reports/fbt" element={<FbtReportPage />} />
            <Route path="reports/tpar" element={<TparReportPage />} />
            <Route path="reports/franking" element={<FrankingReportPage />} />
            <Route path="reports/sgc" element={<SgcReportPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="suppliers/:id" element={<SupplierDetailPage />} />
            <Route path="employees" element={<EmployeesPage />} />
            <Route path="employees/:id" element={<EmployeeDetailPage />} />
            <Route path="fixed-assets" element={<FixedAssetsPage />} />
            <Route path="trusts" element={<TrustsPage />} />
            <Route path="trusts/:id" element={<TrustDetailPage />} />
            <Route path="smsf" element={<SmsfPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="settings/registrations" element={<RegistrationsPage />} />
            <Route path="settings/team" element={<TeamPage />} />
            <Route path="settings/audit-log" element={<AuditLogPage />} />
            <Route path="settings/gmail-callback" element={<GmailCallbackPage />} />
            <Route path="settings/bank-callback" element={<BankCallbackPage />} />
            <Route path="settings/xero-callback" element={<XeroCallbackPage />} />
            <Route path="auth/callback/xero" element={<XeroCallbackPage />} />
            <Route path="payment-runs" element={<PaymentRunsPage />} />
            <Route path="payment-runs/new" element={<NewPaymentRunPage />} />
            <Route path="payment-runs/:id" element={<PaymentRunDetailPage />} />
            <Route path="payroll" element={<PayrollPage />} />
            <Route path="payroll/:id" element={<PayRunDetailPage />} />
            <Route path="onboarding" element={<AutoSetupPage />} />
            <Route path="onboarding/triage" element={<TriagePage />} />
            <Route path="ask" element={<AskPage />} />
            <Route path="legal-horizon" element={<LegalHorizonPage />} />
            <Route path="scan" element={<ScanPage />} />
            <Route path="receipt-hub" element={<ReceiptHubPage />} />
            <Route path="my-activity" element={<MyActivityPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </OrgProvider>
    </AuthProvider>
  );
}
