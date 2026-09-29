/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { LeadProvider, useLeads } from './context/LeadContext';
import { ToastProvider, useToast } from './context/ToastContext';
import { motion, useReducedMotion } from 'motion/react';
import { 
  Sparkles, 
  Layers, 
  TableProperties, 
  Gauge, 
  Wand2, 
  Plus, 
  Database,
  MessageSquare,
  type LucideIcon
} from 'lucide-react';
import { LinkedInProfile, Lead } from './types';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DASHBOARD_NAV_ITEMS,
  getHashForTab,
  getTabFromHash,
  type DashboardTab,
} from './lib/navigation';
import { DEFAULT_MANUAL_INDUSTRY, MANUAL_PROSPECT_INDUSTRIES } from './lib/ui';
import { buildProfileDedupeKeys } from './utils/leadDedupe';

// Large workspaces load only when the user opens their tab.
const ScrapeWorkspace = lazy(() => import('./components/ScrapeWorkspace'));
const BusinessSearchPanel = lazy(() => import('./components/BusinessSearchPanel'));
const CrmPipeline = lazy(() => import('./components/CrmPipeline'));
const LeadTable = lazy(() => import('./components/LeadTable'));
const OutreachStudio = lazy(() => import('./components/OutreachStudio'));
const CrmOverview = lazy(() => import('./components/CrmOverview'));
const CrmCopilot = lazy(() => import('./components/CrmCopilot'));
import TabErrorBoundary from './components/TabErrorBoundary';

interface NavigationItem {
  id: DashboardTab;
  hash: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ICONS: Readonly<Record<DashboardTab, LucideIcon>> = {
  overview: Gauge,
  workspace: Sparkles,
  inventory: TableProperties,
  pipeline: Layers,
  outreach: Wand2,
};

const NAV_ITEMS: readonly NavigationItem[] = DASHBOARD_NAV_ITEMS.map(item => ({
  ...item,
  icon: NAV_ICONS[item.id],
}));


class AppErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Apex CRM render failure:', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
          <section className="mx-auto max-w-xl rounded-xl border border-rose-500/30 bg-slate-900 p-6 shadow-2xl">
            <p className="text-sm font-semibold text-rose-300">Apex CRM could not render this workspace.</p>
            <p className="mt-2 text-sm text-slate-300">
              Reload the app to recover. If this repeats, the browser console contains the underlying error.
            </p>
            <button
              type="button"
              className="mt-5 rounded-md bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400"
              onClick={() => window.location.reload()}
            >
              Reload Apex CRM
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

const TabLoading = () => (
  <div className="min-h-56 grid place-items-center text-sm text-slate-400" role="status">
    Loading workspace...
  </div>
);

const AppShellLoading = () => (
  <div className="min-h-screen bg-[#090d16] text-slate-100" aria-busy="true">
    <header className="border-b border-slate-800 bg-slate-950/80 px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-indigo-500/20" />
          <div className="space-y-2">
            <div className="h-3 w-24 rounded bg-slate-700" />
            <div className="h-2 w-16 rounded bg-slate-800" />
          </div>
        </div>
        <div className="hidden gap-2 lg:flex">
          {NAV_ITEMS.map(item => (
            <div key={item.id} className="h-9 w-20 rounded-lg bg-slate-800/80" />
          ))}
        </div>
        <div className="h-9 w-28 rounded-lg bg-indigo-500/20" />
      </div>
    </header>
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8" role="status">
      <span className="sr-only">Loading CRM data</span>
      <div className="animate-pulse space-y-6 motion-reduce:animate-none">
        <div className="space-y-3">
          <div className="h-6 w-48 rounded bg-slate-700" />
          <div className="h-3 w-full max-w-xl rounded bg-slate-800" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-28 rounded-xl border border-slate-800 bg-slate-900/70" />
          ))}
        </div>
        <div className="h-80 rounded-xl border border-slate-800 bg-slate-900/70" />
      </div>
    </main>
  </div>
);

import { predictiveScoreFromComposite, scoreLeadDeterministically } from './utils/leadScore';

function Dashboard() {
  const {
    leads,
    stats,
    isHydrated,
    refreshStats,
    handleBulkLeadsAdded,
    handleUpdateLeadStage,
    handleUpdateLeadNotes,
    handleUpdateLeadTags,
    handleDeleteLead
  } = useLeads();
  const { triggerToast } = useToast();
  const shouldReduceMotion = useReducedMotion();
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => getTabFromHash(window.location.hash));
  const [mountedJobTabs, setMountedJobTabs] = useState<Set<DashboardTab>>(() => {
    const initialTab = getTabFromHash(window.location.hash);
    return new Set(initialTab === 'workspace' || initialTab === 'inventory' ? [initialTab] : []);
  });
  const [hasLoadedCopilot, setHasLoadedCopilot] = useState(false);
  const [discoverMode, setDiscoverMode] = useState<'people' | 'businesses'>('people');
  const [selectedLeadForOutreach, setSelectedLeadForOutreach] = useState<Lead | null>(null);
  const [showManualModal, setShowManualModal] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualCompany, setManualCompany] = useState('');
  const [manualEmail, setManualEmail] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualIndustry, setManualIndustry] = useState<(typeof MANUAL_PROSPECT_INDUSTRIES)[number]>(DEFAULT_MANUAL_INDUSTRY);
  const [manualSummary, setManualSummary] = useState('');
  const [isSavingManualLead, setIsSavingManualLead] = useState(false);

  const navigateToTab = useCallback((tab: DashboardTab) => {
    setActiveTab(tab);
    const nextHash = getHashForTab(tab);
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, '', nextHash);
    }
  }, []);

  useEffect(() => {
    const syncTabFromLocation = () => setActiveTab(getTabFromHash(window.location.hash));
    if (!window.location.hash) {
      window.history.replaceState(null, '', getHashForTab('overview'));
    }
    window.addEventListener('hashchange', syncTabFromLocation);
    window.addEventListener('popstate', syncTabFromLocation);
    return () => {
      window.removeEventListener('hashchange', syncTabFromLocation);
      window.removeEventListener('popstate', syncTabFromLocation);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'workspace' && activeTab !== 'inventory') return;
    setMountedJobTabs((currentTabs) => {
      if (currentTabs.has(activeTab)) return currentTabs;
      const nextTabs = new Set(currentTabs);
      nextTabs.add(activeTab);
      return nextTabs;
    });
  }, [activeTab]);

  useEffect(() => {
    void refreshStats();
  }, [activeTab, refreshStats]);

  const resetManualForm = useCallback(() => {
    setManualName('');
    setManualTitle('');
    setManualCompany('');
    setManualEmail('');
    setManualUrl('');
    setManualIndustry(DEFAULT_MANUAL_INDUSTRY);
    setManualSummary('');
  }, []);

  const handleManualLeadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const fullName = manualName.trim();
    if (!fullName || isSavingManualLead) return;

    const companyName = manualCompany.trim() || 'Independent';
    const candidateKeys = buildProfileDedupeKeys({
      fullName,
      currentCompany: companyName,
      contactDetails: {
        email: manualEmail,
        linkedinUrl: manualUrl,
      },
    });

    const duplicateLead = leads.find(lead => {
      const leadKeys = buildProfileDedupeKeys(lead.profile || lead);
      for (const k of candidateKeys) {
        if (leadKeys.has(k)) return true;
      }
      return false;
    });

    if (duplicateLead) {
      triggerToast(`${duplicateLead.profile.fullName} is already in Prospects.`, 'info');
      return;
    }

    const newProfile: LinkedInProfile = {
      id: `manual-profile-${crypto.randomUUID()}`,
      fullName,
      headline: manualTitle.trim() ? `${manualTitle.trim()} @ ${companyName}` : `Professional @ ${companyName}`,
      currentCompany: companyName,
      currentTitle: manualTitle.trim() || 'Professional',
      location: 'Undisclosed Location',
      industry: manualIndustry,
      summary: 'Manually added prospect.',
      contactDetails: {
        email: manualEmail.trim() || undefined,
        linkedinUrl: manualUrl.trim() || undefined
      },
      experiences: manualTitle.trim() ? [{ title: manualTitle.trim(), company: companyName }] : []
    };

    const compositeScore = scoreLeadDeterministically(newProfile);
    const predictiveScore = predictiveScoreFromComposite(compositeScore);
    const newLead: Lead = {
      id: `lead-manual-${crypto.randomUUID()}`,
      profile: newProfile,
      stage: 'SCRAPED',
      notes: manualSummary.trim() || 'Manually added contact.',
      createdAt: new Date().toISOString(),
      tags: ['Manual Entry', manualIndustry],
      compositeScore,
      predictiveScore,
      qualificationScore: predictiveScore
    };

    setIsSavingManualLead(true);
    try {
      const result = await handleBulkLeadsAdded([newLead]);
      if (result.addedCount === 0) {
        triggerToast(`${fullName} is already in Prospects.`, 'info');
        return;
      }
      resetManualForm();
      setShowManualModal(false);
      triggerToast(`${fullName} was added to Prospects.`, 'success');
    } catch (error) {
      console.error('Failed to add manual lead:', error);
      triggerToast('Could not save this prospect. Please try again.', 'error');
    } finally {
      setIsSavingManualLead(false);
    }
  };

  const handleSelectLeadForOutreach = useCallback((lead: Lead) => {
    setSelectedLeadForOutreach(lead);
    navigateToTab('outreach');
  }, [navigateToTab]);

  if (!isHydrated) {
    return <AppShellLoading />;
  }

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 font-sans flex flex-col justify-between selection:bg-indigo-500/30 selection:text-white">
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
        className="sr-only z-[70] rounded-md bg-indigo-500 px-4 py-2 font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to workspace
      </a>

      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-primary/5 blur-[120px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-[72px] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-primary text-primary-foreground rounded-xl flex items-center justify-center shadow">
              <Database className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="font-extrabold text-foreground text-sm tracking-tight">
                Apex CRM
              </h1>
              <Badge variant="secondary" className="mt-0.5 text-xs font-bold">
                {stats.total} prospect{stats.total === 1 ? '' : 's'}
              </Badge>
            </div>
          </div>

          <nav className="hidden lg:flex items-center gap-1.5" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isSelected = activeTab === item.id;
              return (
                <Button
                  key={item.id}
                  id={`nav-${item.id}`}
                  type="button"
                  variant={isSelected ? "secondary" : "ghost"}
                  onClick={() => navigateToTab(item.id)}
                  aria-current={isSelected ? 'page' : undefined}
                  className="flex items-center gap-2 h-9 px-3"
                >
                  <Icon className={`w-4 h-4 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
                  {item.label}
                </Button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={() => setShowManualModal(true)}>
              <Plus className="w-4 h-4 mr-1.5" aria-hidden="true" />
              Add prospect
            </Button>
          </div>
        </div>

        <nav
          className="lg:hidden border-t border-slate-800/80 bg-slate-950/60 backdrop-blur-md px-4 py-2 flex gap-1.5 overflow-x-auto select-none"
          aria-label="Mobile navigation"
        >
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            const isSelected = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateToTab(item.id)}
                aria-current={isSelected ? 'page' : undefined}
                className={`px-3 py-2 rounded-lg text-xs font-bold shrink-0 transition-colors flex items-center gap-1.5 cursor-pointer border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                  isSelected
                    ? 'bg-indigo-600 text-white border-indigo-500 shadow-md'
                    : 'bg-slate-900/40 border-slate-800/60 text-slate-400 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 relative z-10 focus:outline-none">
            {(activeTab === 'workspace' || mountedJobTabs.has('workspace')) && (
              <motion.section
                key="tab-workspace"
                hidden={activeTab !== 'workspace'}
                aria-labelledby="discover-heading"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              >
                <div className="mb-6 max-w-3xl">
                  <h2 id="discover-heading" className="text-2xl font-extrabold text-white tracking-tight">Discover prospects</h2>
                  <p className="text-sm leading-6 text-slate-400 mt-1">Find qualified people, review the evidence, then add only the prospects you want to enrich.</p>
                </div>
                <div role="group" aria-label="What to discover" className="mb-4 inline-flex rounded-lg border border-slate-800 bg-slate-900/60 p-1">
                  {([['people', 'People on LinkedIn'], ['businesses', 'Businesses on Facebook']] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={discoverMode === mode}
                      onClick={() => setDiscoverMode(mode)}
                      className={`rounded-md px-3 py-1.5 text-sm font-semibold ${discoverMode === mode ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <Suspense fallback={<TabLoading />}>
                  <TabErrorBoundary tabName="Discover prospects">
                    <div hidden={discoverMode !== 'people'}>
                      <ScrapeWorkspace />
                    </div>
                    {discoverMode === 'businesses' && <BusinessSearchPanel />}
                  </TabErrorBoundary>
                </Suspense>
              </motion.section>
            )}
            {activeTab === 'overview' && (
              <motion.section
                key="tab-overview"
                aria-label="CRM overview"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              >
                <Suspense fallback={<TabLoading />}>
                  <TabErrorBoundary tabName="CRM overview">
                    <CrmOverview leads={leads} stats={stats} />
                  </TabErrorBoundary>
                </Suspense>
              </motion.section>
            )}
            {activeTab === 'pipeline' && (
              <motion.section
                key="tab-pipeline"
                aria-labelledby="pipeline-heading"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              >
                <div className="mb-6 flex justify-between items-center gap-4">
                  <div>
                    <h2 id="pipeline-heading" className="text-2xl font-extrabold text-white tracking-tight">Pipeline</h2>
                    <p className="text-sm leading-6 text-slate-400 mt-1">Move prospects through review, outreach, and follow-up without losing context.</p>
                  </div>
                </div>
                <Suspense fallback={<TabLoading />}>
                  <TabErrorBoundary tabName="Pipeline">
                    <CrmPipeline
                      leads={leads}
                      onUpdateLeadStage={handleUpdateLeadStage}
                      onUpdateLeadNotes={handleUpdateLeadNotes}
                      onUpdateLeadTags={handleUpdateLeadTags}
                      onDeleteLead={handleDeleteLead}
                      onSelectLeadForOutreach={handleSelectLeadForOutreach}
                    />
                  </TabErrorBoundary>
                </Suspense>
              </motion.section>
            )}

            {(activeTab === 'inventory' || mountedJobTabs.has('inventory')) && (
              <motion.section
                key="tab-inventory"
                hidden={activeTab !== 'inventory'}
                aria-label="Prospect inventory"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              >
                <Suspense fallback={<TabLoading />}>
                  <TabErrorBoundary tabName="Prospect inventory">
                    <LeadTable onAddManualLead={() => setShowManualModal(true)} />
                  </TabErrorBoundary>
                </Suspense>
              </motion.section>
            )}

            {activeTab === 'outreach' && (
              <motion.section
                key="tab-outreach"
                aria-labelledby="outreach-heading"
                initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              >
                <div className="mb-6 max-w-3xl">
                  <h2 id="outreach-heading" className="text-2xl font-extrabold text-white tracking-tight">Outreach</h2>
                  <p className="text-sm leading-6 text-slate-400 mt-1">Draft personalized messages from the prospect and account evidence already in your CRM.</p>
                </div>
                <Suspense fallback={<TabLoading />}>
                  <TabErrorBoundary tabName="Outreach">
                    <OutreachStudio
                      selectedLeadForOutreach={selectedLeadForOutreach}
                      leads={leads}
                    />
                  </TabErrorBoundary>
                </Suspense>
              </motion.section>
            )}
      </main>

      {hasLoadedCopilot ? (
        <Suspense
          fallback={(
            <div className="fixed bottom-5 right-5 z-50 grid h-14 w-14 place-items-center rounded-2xl border border-indigo-300/30 bg-indigo-600 text-white" role="status">
              <span className="sr-only">Loading Apex Copilot</span>
              <MessageSquare className="h-6 w-6" aria-hidden="true" />
            </div>
          )}
        >
          <TabErrorBoundary tabName="Apex Copilot">
            <CrmCopilot defaultOpen />
          </TabErrorBoundary>
        </Suspense>
      ) : (
        <button
          type="button"
          onClick={() => setHasLoadedCopilot(true)}
          aria-label="Open Apex Copilot"
          className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-2xl border border-indigo-300/30 bg-gradient-to-br from-indigo-500 to-violet-700 text-white shadow-[0_14px_40px_rgba(79,70,229,0.4)] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        >
          <MessageSquare className="h-6 w-6" aria-hidden="true" />
        </button>
      )}

      <Dialog
        open={showManualModal}
        onOpenChange={(open) => {
          setShowManualModal(open);
          if (!open && !isSavingManualLead) resetManualForm();
        }}
      >
        <DialogContent className="max-w-lg bg-slate-900 border-slate-800 text-slate-100">
          <DialogHeader className="border-b border-slate-800 pb-4">
            <DialogTitle>Add a prospect</DialogTitle>
            <DialogDescription className="text-slate-400">
              Save a contact you already know. Name is required; email and LinkedIn URL improve duplicate detection.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleManualLeadSubmit} aria-busy={isSavingManualLead} className="space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar pr-2 pt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="manual-name" className="text-slate-300">Full name</Label>
                <Input
                  id="manual-name"
                  type="text"
                  required
                  autoComplete="name"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="e.g. John Smith"
                  className="bg-slate-950 border-slate-800"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="manual-industry" className="text-slate-300">Industry</Label>
                <select
                  id="manual-industry"
                  value={manualIndustry}
                  onChange={(e) => setManualIndustry(e.target.value as (typeof MANUAL_PROSPECT_INDUSTRIES)[number])}
                  className="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  {MANUAL_PROSPECT_INDUSTRIES.map(industry => (
                    <option key={industry} value={industry}>{industry}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="manual-title" className="text-slate-300">Current job title</Label>
                <Input
                  id="manual-title"
                  type="text"
                  autoComplete="organization-title"
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  placeholder="e.g. Managing Director"
                  className="bg-slate-950 border-slate-800"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="manual-company" className="text-slate-300">Company name</Label>
                <Input
                  id="manual-company"
                  type="text"
                  autoComplete="organization"
                  value={manualCompany}
                  onChange={(e) => setManualCompany(e.target.value)}
                  placeholder="e.g. Acme Corp"
                  className="bg-slate-950 border-slate-800"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="manual-email" className="text-slate-300">Contact email</Label>
              <Input
                id="manual-email"
                type="email"
                autoComplete="email"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                placeholder="e.g. jsmith@acme.com"
                className="bg-slate-950 border-slate-800"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="manual-linkedin" className="text-slate-300">LinkedIn profile URL</Label>
              <Input
                id="manual-linkedin"
                type="url"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="e.g. https://linkedin.com/in/johnsmith"
                className="bg-slate-950 border-slate-800"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="manual-summary" className="text-slate-300">Notes</Label>
              <Textarea
                id="manual-summary"
                value={manualSummary}
                onChange={(e) => setManualSummary(e.target.value)}
                placeholder="Add useful context for review or outreach..."
                rows={3}
                className="bg-slate-950 border-slate-800 resize-y"
              />
            </div>

            <DialogFooter className="pt-4 border-t border-slate-800">
              <Button
                type="button"
                variant="outline"
                disabled={isSavingManualLead}
                onClick={() => {
                  resetManualForm();
                  setShowManualModal(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSavingManualLead || !manualName.trim()}>
                {isSavingManualLead ? 'Saving...' : 'Add prospect'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <footer className="bg-slate-900/40 border-t border-indigo-500/10 text-slate-500 text-xs text-center py-4">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2.5">
          <span>Discover, qualify, enrich, and contact prospects from one workspace.</span>
          <span className="font-semibold text-slate-400">Apex CRM</span>
        </div>
      </footer>

    </div>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <ToastProvider>
        <LeadProvider>
          <Dashboard />
        </LeadProvider>
      </ToastProvider>
    </AppErrorBoundary>
  );
}
