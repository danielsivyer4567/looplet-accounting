import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/contexts/AuthContext';
import { useAuth } from '@/hooks/useAuth';
import { OrgProvider } from '@/contexts/OrgContext';
import { useOrg } from '@/hooks/useOrg';
import { Layout } from '@/components/Layout';

const LoginPage = lazy(() => import('@/pages/Login').then((m) => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import('@/pages/Signup').then((m) => ({ default: m.SignupPage })));
const AcceptInvitePage = lazy(() =>
  import('@/pages/AcceptInvite').then((m) => ({ default: m.AcceptInvitePage })),
);
const DashboardPage = lazy(() =>
  import('@/pages/Dashboard').then((m) => ({ default: m.DashboardPage })),
);
const BillsPage = lazy(() => import('@/pages/Bills').then((m) => ({ default: m.BillsPage })));
const BillUploadPage = lazy(() =>
  import('@/pages/BillUpload').then((m) => ({ default: m.BillUploadPage })),
);
const BillDetailPage = lazy(() =>
  import('@/pages/BillDetail').then((m) => ({ default: m.BillDetailPage })),
);
const AllocationsPage = lazy(() =>
  import('@/pages/Allocations').then((m) => ({ default: m.AllocationsPage })),
);
const CodingReviewPage = lazy(() =>
  import('@/pages/CodingReview').then((m) => ({ default: m.CodingReviewPage })),
);
const ReconciliationPage = lazy(() =>
  import('@/pages/Reconciliation').then((m) => ({ default: m.ReconciliationPage })),
);
const JobsPage = lazy(() => import('@/pages/Jobs').then((m) => ({ default: m.JobsPage })));
const JobDetailPage = lazy(() =>
  import('@/pages/JobDetail').then((m) => ({ default: m.JobDetailPage })),
);
const CustomersPage = lazy(() =>
  import('@/pages/Customers').then((m) => ({ default: m.CustomersPage })),
);
const CustomerDetailPage = lazy(() =>
  import('@/pages/CustomerDetail').then((m) => ({ default: m.CustomerDetailPage })),
);
const InvoicesPage = lazy(() =>
  import('@/pages/Invoices').then((m) => ({ default: m.InvoicesPage })),
);
const InvoiceDetailPage = lazy(() =>
  import('@/pages/InvoiceDetail').then((m) => ({ default: m.InvoiceDetailPage })),
);
const CreditNotesPage = lazy(() =>
  import('@/pages/CreditNotes').then((m) => ({ default: m.CreditNotesPage })),
);
const SubscriptionsPage = lazy(() =>
  import('@/pages/Subscriptions').then((m) => ({ default: m.SubscriptionsPage })),
);
const SubscriptionDetailPage = lazy(() =>
  import('@/pages/SubscriptionDetail').then((m) => ({ default: m.SubscriptionDetailPage })),
);
const DebtsPage = lazy(() => import('@/pages/Debts').then((m) => ({ default: m.DebtsPage })));
const DebtDetailPage = lazy(() =>
  import('@/pages/DebtDetail').then((m) => ({ default: m.DebtDetailPage })),
);
const QualityPage = lazy(() => import('@/pages/Quality').then((m) => ({ default: m.QualityPage })));
const ReportsIndexPage = lazy(() =>
  import('@/pages/reports/Index').then((m) => ({ default: m.ReportsIndexPage })),
);
const BasReportPage = lazy(() =>
  import('@/pages/reports/Bas').then((m) => ({ default: m.BasReportPage })),
);
const CashFlowPage = lazy(() =>
  import('@/pages/reports/CashFlow').then((m) => ({ default: m.CashFlowPage })),
);
const BalanceSheetPage = lazy(() =>
  import('@/pages/reports/BalanceSheet').then((m) => ({ default: m.BalanceSheetPage })),
);
const EofyReportPage = lazy(() =>
  import('@/pages/reports/EOFY').then((m) => ({ default: m.EofyReportPage })),
);
const TaxReturnPage = lazy(() =>
  import('@/pages/reports/TaxReturn').then((m) => ({ default: m.TaxReturnPage })),
);
const FbtReportPage = lazy(() =>
  import('@/pages/reports/Fbt').then((m) => ({ default: m.FbtReportPage })),
);
const TparReportPage = lazy(() =>
  import('@/pages/reports/Tpar').then((m) => ({ default: m.TparReportPage })),
);
const FrankingReportPage = lazy(() =>
  import('@/pages/reports/Franking').then((m) => ({ default: m.FrankingReportPage })),
);
const SgcReportPage = lazy(() =>
  import('@/pages/reports/Sgc').then((m) => ({ default: m.SgcReportPage })),
);
const NotificationsPage = lazy(() =>
  import('@/pages/Notifications').then((m) => ({ default: m.NotificationsPage })),
);
const SuppliersPage = lazy(() =>
  import('@/pages/Suppliers').then((m) => ({ default: m.SuppliersPage })),
);
const SupplierDetailPage = lazy(() =>
  import('@/pages/SupplierDetail').then((m) => ({ default: m.SupplierDetailPage })),
);
const TrustsPage = lazy(() => import('@/pages/Trusts').then((m) => ({ default: m.TrustsPage })));
const TrustDetailPage = lazy(() =>
  import('@/pages/TrustDetail').then((m) => ({ default: m.TrustDetailPage })),
);
const SmsfPage = lazy(() => import('@/pages/SMSF').then((m) => ({ default: m.SmsfPage })));
const EmployeesPage = lazy(() =>
  import('@/pages/Employees').then((m) => ({ default: m.EmployeesPage })),
);
const EmployeeDetailPage = lazy(() =>
  import('@/pages/EmployeeDetail').then((m) => ({ default: m.EmployeeDetailPage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/Settings').then((m) => ({ default: m.SettingsPage })),
);
const RegistrationsPage = lazy(() =>
  import('@/pages/settings/Registrations').then((m) => ({ default: m.RegistrationsPage })),
);
const TeamPage = lazy(() => import('@/pages/Team').then((m) => ({ default: m.TeamPage })));
const AuditLogPage = lazy(() =>
  import('@/pages/AuditLog').then((m) => ({ default: m.AuditLogPage })),
);
const GmailCallbackPage = lazy(() =>
  import('@/pages/GmailCallback').then((m) => ({ default: m.GmailCallbackPage })),
);
const BankCallbackPage = lazy(() =>
  import('@/pages/BankCallback').then((m) => ({ default: m.BankCallbackPage })),
);
const XeroCallbackPage = lazy(() =>
  import('@/pages/XeroCallback').then((m) => ({ default: m.XeroCallbackPage })),
);
const AutoSetupPage = lazy(() =>
  import('@/pages/onboarding/AutoSetup').then((m) => ({ default: m.AutoSetupPage })),
);
const TriagePage = lazy(() =>
  import('@/pages/onboarding/Triage').then((m) => ({ default: m.TriagePage })),
);
const PaymentRunsPage = lazy(() =>
  import('@/pages/PaymentRuns').then((m) => ({ default: m.PaymentRunsPage })),
);
const ApprovalsPage = lazy(() =>
  import('@/pages/Approvals').then((m) => ({ default: m.ApprovalsPage })),
);
const LodgementsPage = lazy(() =>
  import('@/pages/Lodgements').then((m) => ({ default: m.LodgementsPage })),
);
const NewPaymentRunPage = lazy(() =>
  import('@/pages/NewPaymentRun').then((m) => ({ default: m.NewPaymentRunPage })),
);
const PaymentRunDetailPage = lazy(() =>
  import('@/pages/PaymentRunDetail').then((m) => ({ default: m.PaymentRunDetailPage })),
);
const PayrollPage = lazy(() => import('@/pages/Payroll').then((m) => ({ default: m.PayrollPage })));
const PayRunDetailPage = lazy(() =>
  import('@/pages/PayRunDetail').then((m) => ({ default: m.PayRunDetailPage })),
);
const AskPage = lazy(() => import('@/pages/Ask').then((m) => ({ default: m.AskPage })));
const ScanPage = lazy(() => import('@/pages/Scan').then((m) => ({ default: m.ScanPage })));
const ReceiptHubPage = lazy(() =>
  import('@/pages/ReceiptHub').then((m) => ({ default: m.ReceiptHubPage })),
);
const FixedAssetsPage = lazy(() =>
  import('@/pages/FixedAssets').then((m) => ({ default: m.FixedAssetsPage })),
);
const MyActivityPage = lazy(() =>
  import('@/pages/MyActivity').then((m) => ({ default: m.MyActivityPage })),
);
const LegalHorizonPage = lazy(() =>
  import('@/pages/LegalHorizon').then((m) => ({ default: m.LegalHorizonPage })),
);
const ClientsPage = lazy(() => import('@/pages/Clients').then((m) => ({ default: m.ClientsPage })));
const DataSharingPage = lazy(() =>
  import('@/pages/DataSharing').then((m) => ({ default: m.DataSharingPage })),
);

function RouteFallback() {
  return <div style={{ padding: '2rem' }}>Loading...</div>;
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <RouteFallback />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// Role-aware landing: accountant-only users have no books of their own, so the
// dashboard is empty for them — send them straight to their client picker.
function HomeRoute() {
  const { loading, isAccountantOnly } = useOrg();
  if (loading) return <RouteFallback />;
  if (isAccountantOnly) return <Navigate to="/clients" replace />;
  return <DashboardPage />;
}

export function App() {
  return (
    <AuthProvider>
      <OrgProvider>
        <Suspense fallback={<RouteFallback />}>
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
              <Route path="credit-notes" element={<CreditNotesPage />} />
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
              <Route path="data-sharing" element={<DataSharingPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </OrgProvider>
    </AuthProvider>
  );
}
