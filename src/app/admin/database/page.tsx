"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Database,
  Download,
  Upload,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Table,
  HardDrive,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const runtime = "edge";

interface TableStats {
  name: string;
  rowCount: number;
}

interface DbStats {
  tables: TableStats[];
  summary: {
    tableCount: number;
    totalRows: number;
    indexCount: number;
  };
}

export default function DatabaseManagementPage() {
  const [stats, setStats] = useState<DbStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirmRestore, setConfirmRestore] = useState("");
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/database/stats");
      if (!res.ok) throw new Error("Failed to fetch stats");
      const data = await res.json();
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load database stats");
    } finally {
      setLoading(false);
    }
  };

  const handleBackup = async () => {
    setBackingUp(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch("/api/admin/database/backup");
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Backup failed");
      }

      // Get filename from Content-Disposition header
      const disposition = res.headers.get("Content-Disposition");
      const filenameMatch = disposition?.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : "backup.sql";

      // Download the file
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setSuccess(`Backup downloaded: ${filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setBackingUp(false);
    }
  };

  const handleRestore = async () => {
    if (!restoreFile) {
      setError("Please select a backup file");
      return;
    }

    if (confirmRestore !== "yes-restore-database") {
      setError("Please type 'yes-restore-database' to confirm");
      return;
    }

    setRestoring(true);
    setError("");
    setSuccess("");

    try {
      const formData = new FormData();
      formData.append("file", restoreFile);
      formData.append("confirm", confirmRestore);

      const res = await fetch("/api/admin/database/restore", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Restore failed");
      }

      setSuccess(
        `${data.message} Tables: ${data.details.tablesCreated}, Rows: ${data.details.rowsInserted}${
          data.details.totalErrors > 0 ? `, Errors: ${data.details.totalErrors}` : ""
        }`
      );
      setShowRestoreDialog(false);
      setRestoreFile(null);
      setConfirmRestore("");

      // Refresh stats
      await fetchStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Admin
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Database className="w-6 h-6" />
            Database Management
          </h1>
          <p className="text-gray-600 mt-1">Backup and restore your database</p>
        </div>
        <Button variant="outline" onClick={fetchStats} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-3 bg-green-50 text-green-600 rounded-md text-sm flex items-center gap-2">
          <CheckCircle className="w-4 h-4" />
          {success}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Backup Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="w-5 h-5 text-blue-600" />
              Backup Database
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              Download a complete backup of your database as a SQL file. This includes all tables,
              data, and indexes.
            </p>
            <Button onClick={handleBackup} disabled={backingUp} className="w-full">
              {backingUp ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Creating Backup...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  Download Backup
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Restore Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="w-5 h-5 text-orange-600" />
              Restore Database
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              Restore your database from a backup file. This will replace all existing data.
            </p>
            <Button
              variant="outline"
              onClick={() => setShowRestoreDialog(true)}
              className="w-full border-orange-300 text-orange-700 hover:bg-orange-50"
            >
              <Upload className="w-4 h-4 mr-2" />
              Restore from Backup
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Restore Dialog */}
      {showRestoreDialog && (
        <Card className="mb-6 border-orange-300 bg-orange-50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-orange-700">
              <AlertTriangle className="w-5 h-5" />
              Restore Database
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="bg-white p-4 rounded-lg border border-orange-200">
                <p className="text-sm text-orange-800 font-medium mb-2">Warning:</p>
                <ul className="text-sm text-orange-700 list-disc list-inside space-y-1">
                  <li>This will overwrite ALL existing data</li>
                  <li>This action cannot be undone</li>
                  <li>Make sure you have a current backup before proceeding</li>
                </ul>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Select Backup File (.sql)
                </label>
                <input
                  type="file"
                  accept=".sql"
                  onChange={(e) => setRestoreFile(e.target.files?.[0] || null)}
                  className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-orange-100 file:text-orange-700 hover:file:bg-orange-200"
                />
                {restoreFile && (
                  <p className="text-sm text-gray-600 mt-1">
                    Selected: {restoreFile.name} ({(restoreFile.size / 1024).toFixed(1)} KB)
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Type <code className="bg-gray-100 px-1 rounded">yes-restore-database</code> to
                  confirm
                </label>
                <input
                  type="text"
                  value={confirmRestore}
                  onChange={(e) => setConfirmRestore(e.target.value)}
                  placeholder="yes-restore-database"
                  className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>

              <div className="flex gap-3">
                <Button
                  onClick={handleRestore}
                  disabled={restoring || !restoreFile || confirmRestore !== "yes-restore-database"}
                  className="bg-orange-600 hover:bg-orange-700"
                >
                  {restoring ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Restoring...
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4 mr-2" />
                      Restore Database
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowRestoreDialog(false);
                    setRestoreFile(null);
                    setConfirmRestore("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Database Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-gray-600" />
            Database Statistics
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-4 bg-gray-200 rounded w-1/4"></div>
              <div className="h-32 bg-gray-200 rounded"></div>
            </div>
          ) : stats ? (
            <>
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-gray-50 p-4 rounded-lg text-center">
                  <p className="text-2xl font-bold text-gray-900">{stats.summary.tableCount}</p>
                  <p className="text-sm text-gray-600">Tables</p>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg text-center">
                  <p className="text-2xl font-bold text-gray-900">
                    {stats.summary.totalRows.toLocaleString()}
                  </p>
                  <p className="text-sm text-gray-600">Total Rows</p>
                </div>
                <div className="bg-gray-50 p-4 rounded-lg text-center">
                  <p className="text-2xl font-bold text-gray-900">{stats.summary.indexCount}</p>
                  <p className="text-sm text-gray-600">Indexes</p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        <Table className="w-4 h-4 inline mr-1" />
                        Table Name
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Rows
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {stats.tables.map((table) => (
                      <tr key={table.name} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-mono text-gray-900">{table.name}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 text-right">
                          {table.rowCount >= 0 ? table.rowCount.toLocaleString() : "Error"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-gray-500">Failed to load statistics</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
