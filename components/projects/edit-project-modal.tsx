"use client";
import { useState } from "react";
import { Button, ErrorBox, Field, Input, Select, Textarea } from "@/components/ui";
import { api } from "@/lib/client/api";
import { Modal } from "./modal";
import { ORG_TYPES, type Project } from "./types";

/** Ubah nama, jenis organisasi, dan deskripsi proyek (PATCH). Dirender ulang per pembukaan agar state awal segar. */
export function EditProjectModal({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(project.name);
  const [orgType, setOrgType] = useState(project.orgType ?? "");
  const [description, setDescription] = useState(project.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = (ORG_TYPES as readonly string[]).includes(orgType);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: { name: name.trim(), orgType: orgType || null, description: description.trim() || null },
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Ubah proyek"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Batal
          </Button>
          <Button variant="primary" loading={busy} disabled={name.trim().length < 2} onClick={save}>
            Simpan
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Nama proyek">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Jenis organisasi">
          <Select value={orgType} onChange={(e) => setOrgType(e.target.value)}>
            <option value="">– tidak diisi –</option>
            {!known && orgType && <option value={orgType}>{orgType}</option>}
            {ORG_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Deskripsi">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
        </Field>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}
