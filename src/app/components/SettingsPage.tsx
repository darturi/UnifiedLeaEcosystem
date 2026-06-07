import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Eye, EyeOff, KeyRound, RotateCcw, Save, Settings, X } from 'lucide-react';
import {
  AppSettings,
  PermissionTier,
  SettingsUpdate,
  getSettings,
  saveSettings,
} from '../api';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Slider } from './ui/slider';
import { Progress } from './ui/progress';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';

const MODEL_FAMILIES = [
  { key: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
  { key: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-...' },
  { key: 'google', label: 'Google AI', placeholder: 'AIza...' },
] as const;

const PERMISSION_DETAILS: Record<PermissionTier, { title: string; description: string }> = {
  none: {
    title: 'Fully autonomous',
    description: 'The agent can run without approval prompts.',
  },
  theorem_translation: {
    title: 'Approve theorem formalization',
    description: 'Ask before committing the top-level Lean theorem statement.',
  },
  stepwise: {
    title: 'Approve each agent step',
    description: 'Ask before each agent action during formalization.',
  },
};

type ApiKeyFamily = (typeof MODEL_FAMILIES)[number]['key'];
const API_KEY_PATTERNS: Record<ApiKeyFamily, RegExp> = {
  openai: /^sk-[A-Za-z0-9_-]{8,}$/,
  anthropic: /^sk-ant-.+/,
  google: /^AIza[A-Za-z0-9_-]{20,}$/,
};

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<AppSettings>();
  const [model, setModel] = useState('');
  const [permissionTier, setPermissionTier] = useState<PermissionTier>('theorem_translation');
  const [maxTurns, setMaxTurns] = useState(20);
  const [maxSpend, setMaxSpend] = useState('');
  const [apiKeys, setApiKeys] = useState<Record<ApiKeyFamily, string>>({
    openai: '',
    anthropic: '',
    google: '',
  });
  const [clearedKeys, setClearedKeys] = useState<Record<ApiKeyFamily, boolean>>({
    openai: false,
    anthropic: false,
    google: false,
  });
  const [visibleKeys, setVisibleKeys] = useState<Record<ApiKeyFamily, boolean>>({
    openai: false,
    anthropic: false,
    google: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const load = async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const loaded = await getSettings();
      setSettings(loaded);
      setModel(loaded.model);
      setPermissionTier(loaded.permission_tier);
      setMaxTurns(loaded.max_turns ?? 20);
      setMaxSpend(loaded.max_spend_usd == null ? '' : String(loaded.max_spend_usd));
      setApiKeys({ openai: '', anthropic: '', google: '' });
      setClearedKeys({ openai: false, anthropic: false, google: false });
      setFieldErrors({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load settings.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const currentSpend = settings?.current_spend_usd ?? 0;
  const maxSpendValue = Number(maxSpend);
  const spendPercent = maxSpendValue > 0 ? Math.min(100, (currentSpend / maxSpendValue) * 100) : 0;
  const spendTone =
    spendPercent >= 90
      ? '[&_[data-slot=progress-indicator]]:bg-destructive'
      : spendPercent >= 70
      ? '[&_[data-slot=progress-indicator]]:bg-yellow-500'
      : '[&_[data-slot=progress-indicator]]:bg-primary';

  const groupedModels = useMemo(() => {
    const options = settings?.model_options || [];
    return MODEL_FAMILIES.map((family) => ({
      ...family,
      models: options.filter((option) => option.family === family.key),
    }));
  }, [settings?.model_options]);
  const selectedModelFamily = useMemo(
    () => modelFamilyFor(model, settings) as ApiKeyFamily | undefined,
    [model, settings],
  );
  const selectedFamilyLabel = MODEL_FAMILIES.find((family) => family.key === selectedModelFamily)?.label;

  const submit = async () => {
    setError(undefined);
    setFieldErrors({});
    setSaved(false);
    const localErrors = validateSettingsBeforeSave(settings, model, selectedModelFamily, apiKeys, clearedKeys);
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      setError(Object.values(localErrors)[0]);
      return;
    }
    setIsSaving(true);
    try {
      const apiKeyUpdates: SettingsUpdate['api_keys'] = {};
      for (const family of MODEL_FAMILIES) {
        const value = apiKeys[family.key].trim();
        if (value) {
          apiKeyUpdates[family.key] = { value };
        } else if (clearedKeys[family.key]) {
          apiKeyUpdates[family.key] = { clear: true };
        }
      }
      const update: SettingsUpdate = {
        model,
        permission_tier: permissionTier,
        max_turns: maxTurns,
        max_spend_usd: maxSpend.trim() ? Number(maxSpend) : null,
        api_keys: Object.keys(apiKeyUpdates).length ? apiKeyUpdates : undefined,
      };
      const savedSettings = await saveSettings(update);
      setSettings(savedSettings);
      setModel(savedSettings.model);
      setPermissionTier(savedSettings.permission_tier);
      setMaxTurns(savedSettings.max_turns ?? 20);
      setMaxSpend(savedSettings.max_spend_usd == null ? '' : String(savedSettings.max_spend_usd));
      setApiKeys({ openai: '', anthropic: '', google: '' });
      setClearedKeys({ openai: false, anthropic: false, google: false });
      setFieldErrors({});
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to save settings.';
      const field = err instanceof Error ? (err as Error & { field?: string }).field : undefined;
      if (field) {
        setFieldErrors({ [field]: message });
      }
      setError(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Settings className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">Configure models, approval behavior, and run limits.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close settings"
            title="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-foreground">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="rounded-md border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            Loading settings...
          </div>
        ) : (
          <div className="rounded-md border border-border bg-card">
            <Section title="Model" description="Backend model used for proof formalization.">
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {groupedModels.map((family, index) => (
                    <SelectGroup key={family.key}>
                      <SelectLabel>{family.label}</SelectLabel>
                      {family.models.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                      {index < groupedModels.length - 1 && <SelectSeparator />}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </Section>

            <Separator />

            <Section title="API Keys" description="Configured keys stay in the local backend config.">
              <div className="space-y-4">
                {MODEL_FAMILIES.map((family) => {
                  const status = settings?.api_keys[family.key];
                  const configured = Boolean(status?.configured) && !clearedKeys[family.key];
                  return (
                    <div key={family.key} className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <Label htmlFor={`${family.key}-api-key`}>{family.label}</Label>
                        {configured && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <KeyRound className="h-3.5 w-3.5" />
                            Saved{status?.last4 ? ` ...${status.last4}` : ''}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <Input
                            id={`${family.key}-api-key`}
                            type={visibleKeys[family.key] ? 'text' : 'password'}
                            value={apiKeys[family.key]}
                            placeholder={configured ? 'Enter a new key to replace the saved key' : family.placeholder}
                            onChange={(event) =>
                              setApiKeys((current) => ({ ...current, [family.key]: event.target.value }))
                            }
                            className="pr-10 font-mono"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setVisibleKeys((current) => ({ ...current, [family.key]: !current[family.key] }))
                            }
                            className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Toggle ${family.label} key visibility`}
                            title={`Toggle ${family.label} key visibility`}
                          >
                            {visibleKeys[family.key] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        {status?.configured && (
                          <button
                            type="button"
                            onClick={() =>
                              setClearedKeys((current) => ({ ...current, [family.key]: !current[family.key] }))
                            }
                            className={[
                              'flex h-9 w-9 items-center justify-center rounded-md border transition-colors',
                              clearedKeys[family.key]
                                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                            ].join(' ')}
                            aria-label={clearedKeys[family.key] ? `Keep ${family.label} key` : `Clear ${family.label} key`}
                            title={clearedKeys[family.key] ? `Keep ${family.label} key` : `Clear ${family.label} key`}
                          >
                            {clearedKeys[family.key] ? <RotateCcw className="h-4 w-4" /> : <X className="h-4 w-4" />}
                          </button>
                        )}
                      </div>
                      {fieldErrors[`api_keys.${family.key}`] && (
                        <p className="text-xs text-destructive">{fieldErrors[`api_keys.${family.key}`]}</p>
                      )}
                      {clearedKeys[family.key] && (
                        <p className="text-xs text-destructive">This saved key will be removed on save.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>

            <Separator />

            <Section title="Permission Tier" description="Controls where the agent pauses for approval.">
              <RadioGroup
                value={permissionTier}
                onValueChange={(value) => setPermissionTier(value as PermissionTier)}
                className="gap-2"
              >
                {(settings?.permission_tiers || []).map((tier) => {
                  const detail = PERMISSION_DETAILS[tier.value];
                  return (
                    <Label
                      key={tier.value}
                      className={[
                        'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
                        permissionTier === tier.value ? 'border-primary bg-accent' : 'border-border hover:bg-accent/70',
                      ].join(' ')}
                    >
                      <RadioGroupItem value={tier.value} className="mt-0.5" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">{detail.title}</span>
                        <span className="mt-1 block text-sm font-normal text-muted-foreground">{detail.description}</span>
                      </span>
                    </Label>
                  );
                })}
              </RadioGroup>
            </Section>

            <Separator />

            <Section title="Max Turns" description="Maximum turns the agent may take on a proof attempt.">
              <div className="flex items-center gap-4">
                <Slider
                  min={1}
                  max={100}
                  step={1}
                  value={[maxTurns]}
                  onValueChange={([value]) => setMaxTurns(value)}
                  className="flex-1"
                />
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={maxTurns}
                  onChange={(event) =>
                    setMaxTurns(Math.min(100, Math.max(1, Number(event.target.value) || 1)))
                  }
                  className="w-24"
                />
              </div>
            </Section>

            <Separator />

            <Section title="Max Spend" description="Global spend cap across recorded runs.">
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="relative flex-1">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      $
                    </span>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={maxSpend}
                      onChange={(event) => setMaxSpend(event.target.value)}
                      placeholder="No cap"
                      className="pl-7"
                    />
                  </div>
                  <div className="w-36 text-right text-sm text-muted-foreground">
                    ${currentSpend.toFixed(2)} used
                  </div>
                </div>
                <div className="space-y-2">
                  <Progress value={spendPercent} className={spendTone} />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{spendPercent.toFixed(0)}% of cap</span>
                    <span>{maxSpendValue > 0 ? `$${maxSpendValue.toFixed(2)}` : 'No cap set'}</span>
                  </div>
                </div>
              </div>
            </Section>

            <div className="flex items-center justify-end gap-3 border-t border-border p-5">
              {selectedModelFamily && selectedFamilyLabel && (
                <span className="text-sm text-muted-foreground">{selectedFamilyLabel} key required for this model.</span>
              )}
              {saved && (
                <span className="flex items-center gap-1 text-sm text-green-600">
                  <Check className="h-4 w-4" />
                  Saved
                </span>
              )}
              <button
                type="button"
                onClick={submit}
                disabled={isSaving || !model}
                className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {isSaving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 p-5 md:grid-cols-[minmax(160px,220px)_1fr]">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function modelFamilyFor(model: string, settings?: AppSettings): string | undefined {
  const optionFamily = settings?.model_options.find((option) => option.value === model)?.family;
  if (optionFamily) {
    return optionFamily;
  }
  const normalized = model.toLowerCase();
  if (normalized.startsWith('gpt-') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4') || normalized.startsWith('openai/')) {
    return 'openai';
  }
  if (normalized.startsWith('claude-') || normalized.startsWith('anthropic/')) {
    return 'anthropic';
  }
  if (normalized.startsWith('gemini') || normalized.startsWith('google/')) {
    return 'google';
  }
  return undefined;
}

function validateSettingsBeforeSave(
  settings: AppSettings | undefined,
  model: string,
  selectedFamily: ApiKeyFamily | undefined,
  apiKeys: Record<ApiKeyFamily, string>,
  clearedKeys: Record<ApiKeyFamily, boolean>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const family of MODEL_FAMILIES) {
    const value = apiKeys[family.key].trim();
    if (value && !API_KEY_PATTERNS[family.key].test(value)) {
      errors[`api_keys.${family.key}`] = `The ${family.label} API key does not look valid. Check the key and try again.`;
    }
  }
  if (!selectedFamily) {
    return errors;
  }
  const family = MODEL_FAMILIES.find((item) => item.key === selectedFamily);
  const field = `api_keys.${selectedFamily}`;
  const hasSavedKey = Boolean(settings?.api_keys[selectedFamily]?.configured) && !clearedKeys[selectedFamily];
  const hasNewKey = Boolean(apiKeys[selectedFamily].trim());
  if (!hasSavedKey && !hasNewKey) {
    errors[field] = `Add a ${family?.label || selectedFamily} API key before saving ${model}.`;
  }
  return errors;
}
