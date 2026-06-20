const express = require('express');
const { admin, db } = require('../firebase');
const { verifyToken, requireAdmin } = require('../auth');

const router = express.Router();

const defaultChapters = [
  // Physics
  { id: 'phy_units_dimensions', subject: 'physics', category: 'general', name: 'Units & Dimensions', order: 1 },
  { id: 'phy_kinematics', subject: 'physics', category: 'general', name: 'Kinematics', order: 2 },
  { id: 'phy_laws_of_motion', subject: 'physics', category: 'general', name: 'Laws of Motion', order: 3 },
  { id: 'phy_work_power_energy', subject: 'physics', category: 'general', name: 'Work Power Energy', order: 4 },
  { id: 'phy_centre_of_mass', subject: 'physics', category: 'general', name: 'Centre of Mass', order: 5 },
  { id: 'phy_rotational_motion', subject: 'physics', category: 'general', name: 'Rotational Motion', order: 6 },
  { id: 'phy_gravitation', subject: 'physics', category: 'general', name: 'Gravitation', order: 7 },
  { id: 'phy_properties_of_matter', subject: 'physics', category: 'general', name: 'Properties of Matter', order: 8 },
  { id: 'phy_thermodynamics', subject: 'physics', category: 'general', name: 'Thermodynamics', order: 9 },
  { id: 'phy_shm', subject: 'physics', category: 'general', name: 'SHM', order: 10 },
  { id: 'phy_waves', subject: 'physics', category: 'general', name: 'Waves', order: 11 },
  { id: 'phy_electrostatics', subject: 'physics', category: 'general', name: 'Electrostatics', order: 12 },
  { id: 'phy_current_electricity', subject: 'physics', category: 'general', name: 'Current Electricity', order: 13 },
  { id: 'phy_magnetism', subject: 'physics', category: 'general', name: 'Magnetism', order: 14 },
  { id: 'phy_emi', subject: 'physics', category: 'general', name: 'EMI', order: 15 },
  { id: 'phy_ac', subject: 'physics', category: 'general', name: 'AC', order: 16 },
  { id: 'phy_ray_optics', subject: 'physics', category: 'general', name: 'Ray Optics', order: 17 },
  { id: 'phy_wave_optics', subject: 'physics', category: 'general', name: 'Wave Optics', order: 18 },
  { id: 'phy_modern_physics', subject: 'physics', category: 'general', name: 'Modern Physics', order: 19 },
  { id: 'phy_semiconductor', subject: 'physics', category: 'general', name: 'Semiconductor', order: 20 },

  // Chemistry - Physical Chemistry
  { id: 'chem_mole_concept', subject: 'chemistry', category: 'physical', name: 'Mole Concept', order: 21 },
  { id: 'chem_atomic_structure', subject: 'chemistry', category: 'physical', name: 'Atomic Structure', order: 22 },
  { id: 'chem_chemical_equilibrium', subject: 'chemistry', category: 'physical', name: 'Chemical Equilibrium', order: 23 },
  { id: 'chem_ionic_equilibrium', subject: 'chemistry', category: 'physical', name: 'Ionic Equilibrium', order: 24 },
  { id: 'chem_thermodynamics', subject: 'chemistry', category: 'physical', name: 'Thermodynamics', order: 25 },
  { id: 'chem_electrochemistry', subject: 'chemistry', category: 'physical', name: 'Electrochemistry', order: 26 },
  { id: 'chem_chemical_kinetics', subject: 'chemistry', category: 'physical', name: 'Chemical Kinetics', order: 27 },
  { id: 'chem_solutions', subject: 'chemistry', category: 'physical', name: 'Solutions', order: 28 },

  // Chemistry - Organic Chemistry
  { id: 'chem_goc', subject: 'chemistry', category: 'organic', name: 'GOC', order: 29 },
  { id: 'chem_hydrocarbons', subject: 'chemistry', category: 'organic', name: 'Hydrocarbons', order: 30 },
  { id: 'chem_haloalkanes', subject: 'chemistry', category: 'organic', name: 'Haloalkanes', order: 31 },
  { id: 'chem_alcohol_phenol_ether', subject: 'chemistry', category: 'organic', name: 'Alcohol Phenol Ether', order: 32 },
  { id: 'chem_aldehyde_ketone', subject: 'chemistry', category: 'organic', name: 'Aldehyde Ketone', order: 33 },
  { id: 'chem_carboxylic_acid', subject: 'chemistry', category: 'organic', name: 'Carboxylic Acid', order: 34 },
  { id: 'chem_amines', subject: 'chemistry', category: 'organic', name: 'Amines', order: 35 },
  { id: 'chem_biomolecules', subject: 'chemistry', category: 'organic', name: 'Biomolecules', order: 36 },

  // Chemistry - Inorganic Chemistry
  { id: 'chem_periodic_table', subject: 'chemistry', category: 'inorganic', name: 'Periodic Table', order: 37 },
  { id: 'chem_chemical_bonding', subject: 'chemistry', category: 'inorganic', name: 'Chemical Bonding', order: 38 },
  { id: 'chem_hydrogen', subject: 'chemistry', category: 'inorganic', name: 'Hydrogen', order: 39 },
  { id: 'chem_s_block', subject: 'chemistry', category: 'inorganic', name: 's Block', order: 40 },
  { id: 'chem_p_block', subject: 'chemistry', category: 'inorganic', name: 'p Block', order: 41 },
  { id: 'chem_d_block', subject: 'chemistry', category: 'inorganic', name: 'd Block', order: 42 },
  { id: 'chem_coordination_compounds', subject: 'chemistry', category: 'inorganic', name: 'Coordination Compounds', order: 43 },
  { id: 'chem_metallurgy', subject: 'chemistry', category: 'inorganic', name: 'Metallurgy', order: 44 },

  // Mathematics - Algebra
  { id: 'math_sets', subject: 'mathematics', category: 'algebra', name: 'Sets', order: 45 },
  { id: 'math_relation_function', subject: 'mathematics', category: 'algebra', name: 'Relation & Function', order: 46 },
  { id: 'math_complex_numbers', subject: 'mathematics', category: 'algebra', name: 'Complex Numbers', order: 47 },
  { id: 'math_quadratic_equation', subject: 'mathematics', category: 'algebra', name: 'Quadratic Equation', order: 48 },
  { id: 'math_sequence_series', subject: 'mathematics', category: 'algebra', name: 'Sequence & Series', order: 49 },
  { id: 'math_binomial_theorem', subject: 'mathematics', category: 'algebra', name: 'Binomial Theorem', order: 50 },
  { id: 'math_permutation_combination', subject: 'mathematics', category: 'algebra', name: 'Permutation & Combination', order: 51 },
  { id: 'math_probability', subject: 'mathematics', category: 'algebra', name: 'Probability', order: 52 },

  // Mathematics - Trigonometry
  { id: 'math_trig_ratios', subject: 'mathematics', category: 'trigonometry', name: 'Trigonometric Ratios', order: 53 },
  { id: 'math_trig_equations', subject: 'mathematics', category: 'trigonometry', name: 'Trigonometric Equations', order: 54 },
  { id: 'math_properties_triangle', subject: 'mathematics', category: 'trigonometry', name: 'Properties of Triangle', order: 55 },

  // Mathematics - Coordinate Geometry
  { id: 'math_straight_line', subject: 'mathematics', category: 'coordinate_geometry', name: 'Straight Line', order: 56 },
  { id: 'math_circle', subject: 'mathematics', category: 'coordinate_geometry', name: 'Circle', order: 57 },
  { id: 'math_parabola', subject: 'mathematics', category: 'coordinate_geometry', name: 'Parabola', order: 58 },
  { id: 'math_ellipse', subject: 'mathematics', category: 'coordinate_geometry', name: 'Ellipse', order: 59 },
  { id: 'math_hyperbola', subject: 'mathematics', category: 'coordinate_geometry', name: 'Hyperbola', order: 60 },

  // Mathematics - Calculus
  { id: 'math_limits', subject: 'mathematics', category: 'calculus', name: 'Limits', order: 61 },
  { id: 'math_continuity', subject: 'mathematics', category: 'calculus', name: 'Continuity', order: 62 },
  { id: 'math_differentiation', subject: 'mathematics', category: 'calculus', name: 'Differentiation', order: 63 },
  { id: 'math_application_derivatives', subject: 'mathematics', category: 'calculus', name: 'Application of Derivatives', order: 64 },
  { id: 'math_indefinite_integration', subject: 'mathematics', category: 'calculus', name: 'Indefinite Integration', order: 65 },
  { id: 'math_definite_integration', subject: 'mathematics', category: 'calculus', name: 'Definite Integration', order: 66 },
  { id: 'math_differential_equation', subject: 'mathematics', category: 'calculus', name: 'Differential Equation', order: 67 },

  // Mathematics - Vector & 3D
  { id: 'math_vector_algebra', subject: 'mathematics', category: 'vector_3d', name: 'Vector Algebra', order: 68 },
  { id: 'math_3d_geometry', subject: 'mathematics', category: 'vector_3d', name: '3D Geometry', order: 69 }
];

// Helper to seed default chapters if collection is empty
async function seedChaptersIfNeeded() {
  const snap = await db.collection('prep_chapters').limit(1).get();
  if (snap.empty) {
    console.log('[Seed] Seeding default prep_chapters into Firestore...');
    const batch = db.batch();
    defaultChapters.forEach((ch) => {
      const docRef = db.collection('prep_chapters').doc(ch.id);
      batch.set(docRef, {
        subject: ch.subject,
        category: ch.category,
        name: ch.name,
        order: ch.order,
        lectureLink: '',
        practiceLink: '',
        pyqLink: '',
        notesLink: '',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
    console.log(`[Seed] Seeded ${defaultChapters.length} default chapters.`);
  }
}

// GET /api/prep/chapters - Fetch all chapters
router.get('/chapters', verifyToken, async (req, res) => {
  try {
    await seedChaptersIfNeeded();
    const snap = await db.collection('prep_chapters').get();
    const chapters = [];
    snap.forEach((doc) => {
      chapters.push({ id: doc.id, ...doc.data() });
    });
    chapters.sort((a, b) => (a.order || 0) - (b.order || 0));
    res.json({ ok: true, chapters });
  } catch (err) {
    res.status(500).json({ error: 'chapters_load_failed', message: err.message });
  }
});

// GET /api/prep/progress - Fetch student's progress
router.get('/progress', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db.collection('users').doc(uid).collection('prep_progress').get();
    const progress = {};
    snap.forEach((doc) => {
      progress[doc.id] = doc.data();
    });
    res.json({ ok: true, progress });
  } catch (err) {
    res.status(500).json({ error: 'progress_load_failed', message: err.message });
  }
});

// POST /api/prep/progress - Update status for a chapter
router.post('/progress', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { chapterId, status } = req.body || {};
  if (!chapterId || !status) {
    return res.status(400).json({ error: 'missing_fields', message: 'chapterId and status are required' });
  }

  const validStatuses = ['not_started', 'studying', 'completed', 'needs_revision', 'mastered'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', message: 'Status must be one of: ' + validStatuses.join(', ') });
  }

  try {
    await db.collection('users').doc(uid).collection('prep_progress').doc(chapterId).set({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true, chapterId, status });
  } catch (err) {
    res.status(500).json({ error: 'progress_update_failed', message: err.message });
  }
});

// GET /api/prep/tasks - Fetch student tasks
router.get('/tasks', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db.collection('users').doc(uid).collection('prep_tasks').orderBy('createdAt', 'asc').get();
    const tasks = [];
    snap.forEach((doc) => {
      tasks.push({ id: doc.id, ...doc.data() });
    });
    res.json({ ok: true, tasks });
  } catch (err) {
    res.status(500).json({ error: 'tasks_load_failed', message: err.message });
  }
});

// POST /api/prep/tasks - Add student task
router.post('/tasks', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'missing_text', message: 'Task text is required' });
  }

  try {
    const newTask = {
      text: String(text).trim(),
      completed: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const ref = await db.collection('users').doc(uid).collection('prep_tasks').add(newTask);
    res.json({ ok: true, id: ref.id, ...newTask });
  } catch (err) {
    res.status(500).json({ error: 'task_add_failed', message: err.message });
  }
});

// PATCH /api/prep/tasks/:id - Toggle/update task status
router.patch('/tasks/:id', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { id } = req.params;
  const { completed } = req.body || {};

  if (typeof completed !== 'boolean') {
    return res.status(400).json({ error: 'invalid_payload', message: 'completed status must be boolean' });
  }

  try {
    await db.collection('users').doc(uid).collection('prep_tasks').doc(id).update({
      completed,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true, id, completed });
  } catch (err) {
    res.status(500).json({ error: 'task_update_failed', message: err.message });
  }
});

// DELETE /api/prep/tasks/:id - Delete a task
router.delete('/tasks/:id', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { id } = req.params;

  try {
    await db.collection('users').doc(uid).collection('prep_tasks').doc(id).delete();
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: 'task_delete_failed', message: err.message });
  }
});

// GET /api/prep/mock-tests - Fetch mock scores
router.get('/mock-tests', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db.collection('users').doc(uid).collection('prep_mock_tests').orderBy('createdAt', 'asc').get();
    const tests = [];
    snap.forEach((doc) => {
      tests.push({ id: doc.id, ...doc.data() });
    });
    res.json({ ok: true, tests });
  } catch (err) {
    res.status(500).json({ error: 'mock_tests_load_failed', message: err.message });
  }
});

// POST /api/prep/mock-tests - Add mock score
router.post('/mock-tests', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { date, name, marks } = req.body || {};
  if (!name || marks === undefined || !date) {
    return res.status(400).json({ error: 'missing_fields', message: 'name, marks, and date are required' });
  }

  const numericMarks = Number(marks);
  if (isNaN(numericMarks)) {
    return res.status(400).json({ error: 'invalid_marks', message: 'marks must be numeric' });
  }

  try {
    const newTest = {
      date: String(date).trim(),
      name: String(name).trim(),
      marks: numericMarks,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const ref = await db.collection('users').doc(uid).collection('prep_mock_tests').add(newTest);
    res.json({ ok: true, id: ref.id, ...newTest });
  } catch (err) {
    res.status(500).json({ error: 'mock_test_add_failed', message: err.message });
  }
});

// DELETE /api/prep/mock-tests/:id - Delete mock test
router.delete('/mock-tests/:id', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { id } = req.params;

  try {
    await db.collection('users').doc(uid).collection('prep_mock_tests').doc(id).delete();
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: 'mock_test_delete_failed', message: err.message });
  }
});

// GET /api/prep/admin/analytics - Fetch admin progress analytics (Admin Only)
router.get('/admin/analytics', verifyToken, requireAdmin, async (req, res) => {
  try {
    // 1. Fetch all prep chapters
    await seedChaptersIfNeeded();
    const chaptersSnap = await db.collection('prep_chapters').get();
    const analytics = {};
    chaptersSnap.forEach((doc) => {
      analytics[doc.id] = {
        name: doc.data().name,
        subject: doc.data().subject,
        category: doc.data().category,
        completedCount: 0
      };
    });

    // 2. Query all student progress docs
    // Note: Since Firebase doesn't support recursive queries in a clean single scan without collectionGroups, 
    // we use a collectionGroup query for 'prep_progress' documents. This is extremely efficient!
    const progressGroupSnap = await db.collectionGroup('prep_progress').where('status', '==', 'completed').get();
    
    progressGroupSnap.forEach((doc) => {
      const chapterId = doc.id;
      if (analytics[chapterId]) {
        analytics[chapterId].completedCount++;
      }
    });

    res.json({ ok: true, analytics: Object.keys(analytics).map(id => ({ id, ...analytics[id] })) });
  } catch (err) {
    res.status(500).json({ error: 'analytics_failed', message: err.message });
  }
});

// PUT /api/prep/admin/chapters/:id - Update chapter details (Admin Only)
router.put('/admin/chapters/:id', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, lectureLink, practiceLink, pyqLink, notesLink } = req.body || {};

  const updates = {};
  if (name !== undefined) updates.name = String(name).trim();
  if (lectureLink !== undefined) updates.lectureLink = String(lectureLink).trim();
  if (practiceLink !== undefined) updates.practiceLink = String(practiceLink).trim();
  if (pyqLink !== undefined) updates.pyqLink = String(pyqLink).trim();
  if (notesLink !== undefined) updates.notesLink = String(notesLink).trim();

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no_updates', message: 'No fields provided to update' });
  }

  try {
    await db.collection('prep_chapters').doc(id).update(updates);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: 'chapter_update_failed', message: err.message });
  }
});

// POST /api/prep/admin/chapters - Create a custom chapter (Admin Only)
router.post('/admin/chapters', verifyToken, requireAdmin, async (req, res) => {
  const { subject, category, name, lectureLink, practiceLink, pyqLink, notesLink } = req.body || {};

  if (!subject || !category || !name) {
    return res.status(400).json({ error: 'missing_fields', message: 'subject, category, and name are required' });
  }

  try {
    const countSnap = await db.collection('prep_chapters').get();
    const nextOrder = countSnap.size + 1;
    const newId = `${subject.substring(0, 3)}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now()}`;

    const newChapter = {
      subject: String(subject).trim().toLowerCase(),
      category: String(category).trim().toLowerCase(),
      name: String(name).trim(),
      lectureLink: String(lectureLink || '').trim(),
      practiceLink: String(practiceLink || '').trim(),
      pyqLink: String(pyqLink || '').trim(),
      notesLink: String(notesLink || '').trim(),
      order: nextOrder,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('prep_chapters').doc(newId).set(newChapter);
    res.json({ ok: true, id: newId, ...newChapter });
  } catch (err) {
    res.status(500).json({ error: 'chapter_create_failed', message: err.message });
  }
});

// DELETE /api/prep/admin/chapters/:id - Delete a chapter (Admin Only)
router.delete('/admin/chapters/:id', verifyToken, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await db.collection('prep_chapters').doc(id).delete();
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: 'chapter_delete_failed', message: err.message });
  }
});

module.exports = router;
